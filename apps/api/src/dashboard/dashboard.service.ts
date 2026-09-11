import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@crm/database';
import { PrismaService } from '../prisma/prisma.service';
import { PlanningsService } from '../plannings/plannings.service';
import { idReprVariants } from '../common/id-repr.util';

/** Clé canonique d'un code représentant : « 068 » et « 68 » comptent ensemble. */
function canonRepr(code: string): string {
  const c = code.trim();
  return /^\d+$/.test(c) ? String(Number(c)) : c;
}

export interface DashboardData {
  scope: { type: 'global' | 'commercial'; idRepr: string | null; label: string };
  kpis: { ca: string; commandes: number; annulees: number; clients: number; panierMoyen: string };
  objectif: { cible: string | null; realise: string; tauxPct: number | null };
  visites: { moisRealisees: number; objectif: number | null; tauxPct: number | null };
  tournee: { id: string; nom: string; ville: string | null; adresse: string | null; fait: boolean }[];
  alertes: { produitsRappel: { count: number; items: { code: string; libelle: string }[] } };
  topClients: { nom: string; ca: string; commandes: number }[];
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plannings: PlanningsService,
  ) {}

  async forUser(user: { id: string; idRepr: string | null }): Promise<DashboardData> {
    const idRepr = user.idRepr ?? null;
    // Équivalence AD (« 68 ») ↔ Minos (« 068 ») gérée à la comparaison.
    const repWhere = idRepr ? { idRepr: { in: idReprVariants(idRepr) } } : {};
    const whereActives: Prisma.CommandeWhereInput = { dateAnnulation: null, ...repWhere };

    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // La tournée du jour inclut les visites issues des règles de récurrence.
    await this.plannings.ensureOccurrences(user.id, dayStart, dayEnd);

    const [commandes, annulees, caAgg, clientGroups, topClients, plannings, visitesMois, rappelCount, rappelItems] =
      await Promise.all([
        this.prisma.commande.count({ where: whereActives }),
        this.prisma.commande.count({ where: { dateAnnulation: { not: null }, ...repWhere } }),
        this.prisma.commandeLigne.aggregate({ _sum: { montant: true }, where: { commande: whereActives } }),
        this.prisma.commande.groupBy({ by: ['clientId'], where: whereActives }),
        this.topClients(idRepr),
        this.prisma.planning.findMany({
          where: { promoteurId: user.id, deletedAt: null, datePassage: { gte: dayStart, lt: dayEnd } },
          select: {
            id: true,
            fait: true,
            client: {
              select: { enseigne: true, raisonSociale: true, ville: true, adresse1: true, codePostal: true },
            },
          },
          orderBy: { datePassage: 'asc' },
        }),
        this.prisma.visite.count({ where: { promoteurId: user.id, createdAt: { gte: monthStart } } }),
        this.prisma.article.count({ where: { deletedAt: null, retourAutorise: true } }),
        this.prisma.article.findMany({
          where: { deletedAt: null, retourAutorise: true },
          select: { codeAs400: true, libelle: true },
          orderBy: { libelle: 'asc' },
          take: 5,
        }),
      ]);

    const ca = caAgg._sum.montant ? caAgg._sum.montant.toString() : '0';
    const clients = clientGroups.filter((g) => g.clientId).length;
    const panierMoyen = commandes > 0 ? (Number(ca) / commandes).toFixed(2) : '0';

    const tournee = plannings.map((p) => ({
      id: p.id,
      nom: (p.client.enseigne || p.client.raisonSociale || '(client)').trim(),
      ville: p.client.ville?.trim() || null,
      adresse: [p.client.adresse1, p.client.codePostal, p.client.ville]
        .map((s) => s?.trim())
        .filter((s) => s && s !== '.')
        .join(' ') || null,
      fait: p.fait,
    }));

    return {
      scope: {
        type: idRepr ? 'commercial' : 'global',
        idRepr,
        label: idRepr ? `Commercial ${idRepr}` : 'Vue globale (tous commerciaux)',
      },
      kpis: { ca, commandes, annulees, clients, panierMoyen },
      objectif: { cible: null, realise: ca, tauxPct: null }, // modèle Objectif à venir
      visites: { moisRealisees: visitesMois, objectif: null, tauxPct: null }, // objectif visites à venir
      tournee,
      alertes: {
        produitsRappel: {
          count: rappelCount,
          items: rappelItems.map((a) => ({ code: a.codeAs400, libelle: a.libelle })),
        },
      },
      topClients,
    };
  }

  /**
   * Dashboard de pilotage (helios) : chiffres consolidés de toute la force de vente
   * sur un mois donné, avec comparatif N-1, classement des promoteurs, agrégats
   * par secteur, suivi des objectifs et magasins sans commande.
   * Un CHEF_SECTEUR est automatiquement restreint aux promoteurs de ses secteurs.
   */
  async direction(me: { id: string; role: Role }, annee: number, mois: number) {
    const debut = new Date(annee, mois - 1, 1);
    const fin = new Date(annee, mois, 1);
    const debutN1 = new Date(annee - 1, mois - 1, 1);
    const finN1 = new Date(annee - 1, mois, 1);

    const scopeSecteur = me.role === Role.CHEF_SECTEUR;

    // Force de vente visible (comptes reliés à l'ERP par un code représentant).
    const promoteurs = await this.prisma.user.findMany({
      where: {
        idRepr: { not: null },
        ...(scopeSecteur ? { secteur: { managerId: me.id } } : {}),
      },
      select: {
        id: true,
        displayName: true,
        idRepr: true,
        isActive: true,
        secteur: { select: { id: true, code: true, nom: true } },
      },
      orderBy: { displayName: 'asc' },
    });

    // Toutes les variantes de tous les codes visibles (pour filtrer les requêtes SQL en mode secteur).
    const codesScope = new Set<string>();
    for (const p of promoteurs) for (const v of idReprVariants(p.idRepr!)) codesScope.add(v);

    const emptyScope = scopeSecteur && codesScope.size === 0;
    const reprFilter =
      scopeSecteur && !emptyScope
        ? Prisma.sql`AND co."idRepr" IN (${Prisma.join([...codesScope])})`
        : Prisma.empty;

    // CA + nb commandes par représentant, mois N et même mois N-1, en une requête.
    const caParRepr = emptyScope
      ? []
      : await this.prisma.$queryRaw<{ idRepr: string; annee: number; ca: number; nb: number }[]>`
          SELECT co."idRepr",
                 EXTRACT(YEAR FROM co."dateCommande")::int AS annee,
                 COALESCE(SUM(cl.montant), 0)::float8 AS ca,
                 COUNT(DISTINCT co.id)::int AS nb
          FROM commandes co
          JOIN commande_lignes cl ON cl."commandeId" = co.id
          WHERE co."idRepr" IS NOT NULL
            AND co."dateAnnulation" IS NULL
            AND ((co."dateCommande" >= ${debut} AND co."dateCommande" < ${fin})
              OR (co."dateCommande" >= ${debutN1} AND co."dateCommande" < ${finN1}))
            ${reprFilter}
          GROUP BY 1, 2
        `;

    // Courbe CA mensuelle N / N-1 (périmètre identique).
    const courbeRows = emptyScope
      ? []
      : await this.prisma.$queryRaw<{ annee: number; mois: number; ca: number }[]>`
          SELECT EXTRACT(YEAR FROM co."dateCommande")::int AS annee,
                 EXTRACT(MONTH FROM co."dateCommande")::int AS mois,
                 COALESCE(SUM(cl.montant), 0)::float8 AS ca
          FROM commandes co
          JOIN commande_lignes cl ON cl."commandeId" = co.id
          WHERE co."dateAnnulation" IS NULL
            AND co."dateCommande" IS NOT NULL
            AND EXTRACT(YEAR FROM co."dateCommande") IN (${annee}, ${annee - 1})
            ${reprFilter}
          GROUP BY 1, 2
          ORDER BY 1, 2
        `;

    // Périmètre magasins : tout le parc actif, ou le portefeuille des codes du secteur.
    const clientsWhere: Prisma.ClientWhereInput = {
      deletedAt: null,
      actif: true,
      ...(scopeSecteur
        ? {
            OR: [
              { idCommercial1: { in: [...codesScope] } },
              { idCommercial2: { in: [...codesScope] } },
            ],
          }
        : {}),
    };
    const sansCommandeWhere: Prisma.ClientWhereInput = {
      ...clientsWhere,
      commandes: { none: { dateAnnulation: null, dateCommande: { gte: debut, lt: fin } } },
    };

    const [commandants, magasinsTotal, sansCommandeCount, sansCommandeExemples, objectifs, secteurs] =
      await Promise.all([
        emptyScope
          ? Promise.resolve([])
          : this.prisma.commande.groupBy({
              by: ['clientId'],
              where: {
                dateAnnulation: null,
                dateCommande: { gte: debut, lt: fin },
                clientId: { not: null },
                ...(scopeSecteur ? { idRepr: { in: [...codesScope] } } : {}),
              },
            }),
        emptyScope ? Promise.resolve(0) : this.prisma.client.count({ where: clientsWhere }),
        emptyScope ? Promise.resolve(0) : this.prisma.client.count({ where: sansCommandeWhere }),
        emptyScope
          ? Promise.resolve([])
          : this.prisma.client.findMany({
              where: sansCommandeWhere,
              select: { id: true, enseigne: true, raisonSociale: true, ville: true, niveauClass: true },
              orderBy: { enseigne: 'asc' },
              take: 8,
            }),
        // Objectifs ANNUELS par magasin, avec les codes commerciaux du magasin
        // pour reconstituer l'objectif de chaque représentant (mensuel = /12).
        this.prisma.objectif.findMany({
          where: {
            annee,
            client: {
              deletedAt: null,
              ...(scopeSecteur
                ? {
                    OR: [
                      { idCommercial1: { in: [...codesScope] } },
                      { idCommercial2: { in: [...codesScope] } },
                    ],
                  }
                : {}),
            },
          },
          select: {
            cibleCa: true,
            client: { select: { idCommercial1: true, idCommercial2: true } },
          },
        }),
        this.prisma.secteur.findMany({
          where: scopeSecteur ? { managerId: me.id } : {},
          select: { id: true, code: true, nom: true, manager: { select: { displayName: true } } },
          orderBy: { code: 'asc' },
        }),
      ]);

    // Fusion des variantes de codes (« 068 » = « 68 »).
    const caN = new Map<string, { ca: number; nb: number }>();
    const caN1 = new Map<string, number>();
    for (const r of caParRepr) {
      const key = canonRepr(r.idRepr);
      if (r.annee === annee) {
        const cur = caN.get(key) ?? { ca: 0, nb: 0 };
        caN.set(key, { ca: cur.ca + r.ca, nb: cur.nb + r.nb });
      } else {
        caN1.set(key, (caN1.get(key) ?? 0) + r.ca);
      }
    }
    // Objectif MENSUEL par représentant = somme des cibles annuelles de ses magasins / 12
    // (un magasin partagé compte pour chacun de ses deux commerciaux).
    const objParRepr = new Map<string, number>();
    for (const o of objectifs) {
      const cibleMensuelle = Number(o.cibleCa) / 12;
      const codes = new Set(
        [o.client.idCommercial1, o.client.idCommercial2]
          .filter((c): c is string => Boolean(c?.trim()))
          .map(canonRepr),
      );
      for (const c of codes) objParRepr.set(c, (objParRepr.get(c) ?? 0) + cibleMensuelle);
    }
    for (const [k, v] of objParRepr) objParRepr.set(k, Math.round(v));

    // Classement des promoteurs.
    const vus = new Set<string>();
    const classement = promoteurs.map((p) => {
      const key = canonRepr(p.idRepr!);
      vus.add(key);
      const n = caN.get(key);
      const n1 = caN1.get(key) ?? 0;
      const cible = objParRepr.get(key) ?? null;
      const ca = n?.ca ?? 0;
      return {
        userId: p.id as string | null,
        nom: p.displayName,
        idRepr: p.idRepr!,
        isActive: p.isActive,
        secteur: p.secteur ? { id: p.secteur.id, code: p.secteur.code, nom: p.secteur.nom } : null,
        ca,
        commandes: n?.nb ?? 0,
        caN1: n1,
        deltaPct: n1 > 0 ? Math.round(((ca - n1) / n1) * 100) : null,
        objectif: cible,
        tauxPct: cible && cible > 0 ? Math.round((ca / cible) * 100) : null,
      };
    });
    // Codes représentants avec du CA mais sans compte utilisateur (visibilité, hors mode secteur).
    if (!scopeSecteur) {
      for (const [key, n] of caN) {
        if (vus.has(key)) continue;
        const n1 = caN1.get(key) ?? 0;
        const cible = objParRepr.get(key) ?? null;
        classement.push({
          userId: null,
          nom: `Code ${key} (sans compte)`,
          idRepr: key,
          isActive: true,
          secteur: null,
          ca: n.ca,
          commandes: n.nb,
          caN1: n1,
          deltaPct: n1 > 0 ? Math.round(((n.ca - n1) / n1) * 100) : null,
          objectif: cible,
          tauxPct: cible && cible > 0 ? Math.round((n.ca / cible) * 100) : null,
        });
      }
    }
    classement.sort((a, b) => b.ca - a.ca);

    // Agrégats par secteur (bucket « Hors secteur » pour les non-rattachés).
    const parSecteur = new Map<
      string,
      { id: string | null; code: string; nom: string; chef: string | null; promoteurs: number; ca: number; caN1: number; objectif: number }
    >();
    for (const s of secteurs) {
      parSecteur.set(s.id, {
        id: s.id, code: s.code, nom: s.nom,
        chef: s.manager?.displayName ?? null,
        promoteurs: 0, ca: 0, caN1: 0, objectif: 0,
      });
    }
    const HORS = '__hors__';
    for (const row of classement) {
      const key = row.secteur?.id ?? HORS;
      if (!parSecteur.has(key)) {
        parSecteur.set(key, {
          id: row.secteur?.id ?? null,
          code: row.secteur?.code ?? '—',
          nom: row.secteur?.nom ?? 'Hors secteur',
          chef: null, promoteurs: 0, ca: 0, caN1: 0, objectif: 0,
        });
      }
      const s = parSecteur.get(key)!;
      s.promoteurs += 1;
      s.ca += row.ca;
      s.caN1 += row.caN1;
      s.objectif += row.objectif ?? 0;
    }
    const caParSecteur = [...parSecteur.values()]
      .sort((a, b) => b.ca - a.ca)
      .map((s) => ({
        ...s,
        deltaPct: s.caN1 > 0 ? Math.round(((s.ca - s.caN1) / s.caN1) * 100) : null,
        tauxPct: s.objectif > 0 ? Math.round((s.ca / s.objectif) * 100) : null,
      }));

    // Suivi des objectifs du mois.
    let atteints = 0;
    for (const [key, cible] of objParRepr) {
      if (cible > 0 && (caN.get(key)?.ca ?? 0) >= cible) atteints += 1;
    }
    const promoteursActifs = promoteurs.filter((p) => p.isActive);
    const sansObjectif = promoteursActifs.filter((p) => !objParRepr.has(canonRepr(p.idRepr!))).length;

    // Courbes 12 mois.
    const courbeN = Array<number>(12).fill(0);
    const courbeN1 = Array<number>(12).fill(0);
    for (const r of courbeRows) {
      if (r.annee === annee) courbeN[r.mois - 1] = r.ca;
      else if (r.annee === annee - 1) courbeN1[r.mois - 1] = r.ca;
    }

    let caTotal = 0, nbCommandes = 0, caTotalN1 = 0;
    for (const n of caN.values()) { caTotal += n.ca; nbCommandes += n.nb; }
    for (const v of caN1.values()) caTotalN1 += v;

    return {
      periode: { annee, mois },
      scope: {
        type: scopeSecteur ? ('secteur' as const) : ('global' as const),
        label: scopeSecteur
          ? `Mes secteurs (${secteurs.map((s) => s.code).join(', ') || 'aucun'})`
          : 'Toute la force de vente',
      },
      kpis: {
        ca: caTotal,
        caN1: caTotalN1,
        deltaPct: caTotalN1 > 0 ? Math.round(((caTotal - caTotalN1) / caTotalN1) * 100) : null,
        commandes: nbCommandes,
        panierMoyen: nbCommandes > 0 ? caTotal / nbCommandes : 0,
        magasinsCommandants: commandants.length,
        magasinsTotal,
      },
      ca12mois: { anneeN: annee, courbeN, courbeN1 },
      classement,
      caParSecteur,
      objectifs: {
        definis: objParRepr.size,
        atteints,
        manques: objParRepr.size - atteints,
        sansObjectif,
      },
      sansCommande: {
        total: sansCommandeCount,
        exemples: sansCommandeExemples.map((c) => ({
          id: c.id,
          nom: (c.enseigne || c.raisonSociale).trim(),
          ville: c.ville?.trim() || null,
          niveauClass: c.niveauClass,
        })),
      },
    };
  }

  private async topClients(idRepr: string | null) {
    const repFilter = idRepr
      ? Prisma.sql`AND co."idRepr" IN (${Prisma.join(idReprVariants(idRepr))})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ nom: string | null; ca: string; nb: number }[]>`
      SELECT co."raisonSocialeCmd" AS nom,
             SUM(cl.montant)::text AS ca,
             COUNT(DISTINCT co.id)::int AS nb
      FROM commande_lignes cl
      JOIN commandes co ON co.id = cl."commandeId"
      WHERE co."dateAnnulation" IS NULL ${repFilter}
      GROUP BY co."raisonSocialeCmd"
      ORDER BY SUM(cl.montant) DESC
      LIMIT 5`;
    return rows.map((r) => ({ nom: r.nom?.trim() || '(sans nom)', ca: r.ca, commandes: r.nb }));
  }
}
