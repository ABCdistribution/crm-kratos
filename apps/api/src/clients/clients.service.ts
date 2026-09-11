import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { QueryClientsDto } from './dto/query-clients.dto';
import { CreateContactDto, UpdateContactDto } from './dto/contact.dto';
import { idReprVariants } from '../common/id-repr.util';

/** Intervalle en jours déduit du libellé de périodicité (référentiel legacy 1..6). */
function joursPeriodicite(libelle?: string | null): number | null {
  if (!libelle) return null;
  const l = libelle
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (l.includes('2 fois par semaine')) return 4;
  if (l.includes('fois par semaine')) return 7; // 1 fois / semaine
  if (l.includes('2 semaines')) return 14;
  if (l.includes('3 semaines')) return 21;
  if (l.includes("plus d'un mois")) return 45;
  if (l.includes('fois par mois') || l.includes('mensuel')) return 30;
  // Anciens libellés (compat)
  if (l.includes('hebdo')) return 7;
  if (l.includes('trimestriel')) return 90;
  if (l.includes('semestriel')) return 180;
  if (l.includes('annuel')) return 365;
  return null;
}

/** Forme d'un magasin chargé avec ses relations pour l'enrichissement. */
type EnrichInput = {
  id: string;
  codeAs400: string;
  enseigne: string;
  raisonSociale: string;
  ville: string | null;
  codePostal: string | null;
  actif: boolean;
  niveauClass: string | null;
  commerciaux: { id: string; displayName: string; idRepr: string | null }[];
  periodicites: { periodicite: { code: number | null; libelle: string } }[];
};

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryClientsDto, user?: { role: string; idRepr: string | null }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Un commercial relié à un code représentant ne voit que SES magasins
    // (il est idCommercial1 ou idCommercial2, équivalence « 68 » ↔ « 068 » incluse).
    // Un non-commercial (direction) peut demander le portefeuille d'un code via ?repr=.
    const mine =
      user?.role === 'COMMERCIAL' && user.idRepr
        ? idReprVariants(user.idRepr)
        : query.repr
          ? idReprVariants(query.repr)
          : null;

    const where: Prisma.ClientWhereInput = {
      deletedAt: null,
      ...(mine
        ? { OR: [{ idCommercial1: { in: mine } }, { idCommercial2: { in: mine } }] }
        : {}),
      ...(query.search
        ? {
            // AND explicite pour ne pas écraser le OR du scoping.
            AND: [
              {
                OR: [
                  { enseigne: { contains: query.search, mode: 'insensitive' } },
                  { raisonSociale: { contains: query.search, mode: 'insensitive' } },
                  { codeAs400: { contains: query.search, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };

    const enrich = query.enrich === 'true' || query.enrich === '1';

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        ...(enrich
          ? {
              include: {
                commerciaux: { select: { id: true, displayName: true, idRepr: true } },
                periodicites: {
                  where: { deletedAt: null },
                  take: 1,
                  orderBy: { createdAt: 'desc' as const },
                  select: { periodicite: { select: { code: true, libelle: true } } },
                },
              },
            }
          : {}),
      }),
      this.prisma.client.count({ where }),
    ]);

    return {
      data: enrich ? await this.enrichirClients(data as unknown as EnrichInput[]) : data,
      total,
      page,
      limit,
      scope:
        user?.role === 'COMMERCIAL' && user.idRepr
          ? { type: 'mine' as const, idRepr: user.idRepr }
          : query.repr
            ? { type: 'repr' as const, idRepr: query.repr }
            : { type: 'global' as const, idRepr: null },
    };
  }

  /**
   * Ajoute à chaque magasin de la page : CA du mois, Δ vs N-1, dernière visite
   * (en jours) + périodicité, CS (commercial), et un état/alerte DÉRIVÉS.
   * Règles dérivées (ajustables) : « en retard » si jours depuis la dernière
   * visite > intervalle de la périodicité ; alerte = en retard ; état = 🟢 si à
   * jour et CA ≥ N-1, 🟠 si en retard OU CA en baisse, 🔴 si les deux.
   */
  private async enrichirClients(rows: EnrichInput[]) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];

    const now = new Date();
    const debut = new Date(now.getFullYear(), now.getMonth(), 1);
    const fin = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const debutN1 = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const finN1 = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1);

    const [caMois, caN1, derniereVisite] = await Promise.all([
      this.prisma.$queryRaw<{ clientId: string; ca: number }[]>`
        SELECT co."clientId", COALESCE(SUM(cl.montant), 0)::float8 AS ca
        FROM commandes co JOIN commande_lignes cl ON cl."commandeId" = co.id
        WHERE co."clientId" = ANY(${ids}::uuid[])
          AND co."dateAnnulation" IS NULL
          AND co."dateCommande" >= ${debut} AND co."dateCommande" < ${fin}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ clientId: string; ca: number }[]>`
        SELECT co."clientId", COALESCE(SUM(cl.montant), 0)::float8 AS ca
        FROM commandes co JOIN commande_lignes cl ON cl."commandeId" = co.id
        WHERE co."clientId" = ANY(${ids}::uuid[])
          AND co."dateAnnulation" IS NULL
          AND co."dateCommande" >= ${debutN1} AND co."dateCommande" < ${finN1}
        GROUP BY 1`,
      this.prisma.visite.groupBy({
        by: ['clientId'],
        where: { clientId: { in: ids }, deletedAt: null },
        _max: { createdAt: true },
      }),
    ]);

    const caMoisById = new Map(caMois.map((r) => [r.clientId, r.ca]));
    const caN1ById = new Map(caN1.map((r) => [r.clientId, r.ca]));
    const derVisById = new Map(derniereVisite.map((r) => [r.clientId, r._max.createdAt]));

    return rows.map((c) => {
      const ca = caMoisById.get(c.id) ?? 0;
      const n1 = caN1ById.get(c.id) ?? 0;
      const deltaPct = n1 > 0 ? Math.round(((ca - n1) / n1) * 100) : null;

      const derniere = derVisById.get(c.id) ?? null;
      const jours = derniere
        ? Math.floor((now.getTime() - new Date(derniere).getTime()) / 86_400_000)
        : null;

      const periodicite = c.periodicites[0]?.periodicite ?? null;
      const intervalle = joursPeriodicite(periodicite?.libelle);
      const enRetard = intervalle !== null && jours !== null && jours > intervalle;

      const enBaisse = deltaPct !== null && deltaPct < 0;
      const alertes = enRetard ? 1 : 0;
      const etat = enRetard && enBaisse ? 'alerte' : enRetard || enBaisse ? 'attention' : 'ok';

      const cs = c.commerciaux[0] ?? null;

      return {
        id: c.id,
        codeAs400: c.codeAs400,
        enseigne: c.enseigne,
        raisonSociale: c.raisonSociale,
        ville: c.ville,
        codePostal: c.codePostal,
        actif: c.actif,
        niveauClass: c.niveauClass,
        cs: cs ? { id: cs.id, displayName: cs.displayName, idRepr: cs.idRepr } : null,
        caMois: ca,
        deltaPct,
        derniereVisiteJours: jours,
        periodicite: periodicite?.libelle ?? null,
        enRetard,
        enBaisse,
        alertes,
        etat,
      };
    });
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findFirst({ where: { id, deletedAt: null } });
    if (!client) {
      throw new NotFoundException(`Client ${id} introuvable`);
    }
    return client;
  }

  /** Fiche magasin complète : relations CRM + compteurs (visites, commandes). */
  async findOneDetail(id: string) {
    const client = await this.prisma.client.findFirst({
      where: { id, deletedAt: null },
      include: {
        secteur: { select: { id: true, code: true, nom: true } },
        centrale: { select: { id: true, code: true, nom: true } },
        commerciaux: { select: { id: true, displayName: true, idRepr: true, role: true } },
        contacts: {
          where: { deletedAt: null },
          orderBy: [{ nom: 'asc' }],
          select: {
            id: true,
            prenom: true,
            nom: true,
            poste: true,
            typePoste: true,
            fixe: true,
            portable: true,
            mail: true,
          },
        },
        notes: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            remarque: true,
            createdAt: true,
            auteur: { select: { displayName: true } },
          },
        },
        periodicites: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, periodicite: { select: { id: true, code: true, libelle: true } } },
        },
        _count: { select: { visites: true, commandes: true } },
      },
    });
    if (!client) {
      throw new NotFoundException(`Client ${id} introuvable`);
    }
    return client;
  }

  /**
   * Historique du magasin : dernières commandes, dernières visites,
   * et CA mensuel N / N-1 (commandes non annulées).
   */
  async findHistorique(id: string) {
    await this.findOne(id); // 404 si le client n'existe pas

    const anneeN = new Date().getFullYear();

    const [commandes, visites, caRows] = await Promise.all([
      this.prisma.commande.findMany({
        where: { clientId: id },
        orderBy: [{ dateCommande: 'desc' }, { createdAt: 'desc' }],
        take: 10,
        select: {
          id: true,
          numero: true,
          typeCmd: true,
          dateCommande: true,
          dateAnnulation: true,
          idRepr: true, // toutes les commandes du magasin, y compris celles d'autres représentants
          idCommandeApk: true,
          lignes: { select: { montant: true } },
        },
      }),
      this.prisma.visite.findMany({
        where: { clientId: id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          createdAt: true,
          dnAbc: true,
          dnConcurrence: true,
          pem: true,
          promoteur: { select: { displayName: true } },
          _count: { select: { photos: true } },
        },
      }),
      this.prisma.$queryRaw<{ annee: number; mois: number; ca: number }[]>`
        SELECT EXTRACT(YEAR FROM c."dateCommande")::int AS annee,
               EXTRACT(MONTH FROM c."dateCommande")::int AS mois,
               COALESCE(SUM(l.montant), 0)::float8 AS ca
        FROM commandes c
        JOIN commande_lignes l ON l."commandeId" = c.id
        WHERE c."clientId" = ${id}::uuid
          AND c."dateAnnulation" IS NULL
          AND c."dateCommande" IS NOT NULL
          AND EXTRACT(YEAR FROM c."dateCommande") IN (${anneeN}, ${anneeN - 1})
        GROUP BY 1, 2
        ORDER BY 1, 2
      `,
    ]);

    // CA par mois sur 12 colonnes, pour N et N-1.
    const caN = Array<number>(12).fill(0);
    const caN1 = Array<number>(12).fill(0);
    for (const r of caRows) {
      if (r.annee === anneeN) caN[r.mois - 1] = r.ca;
      else if (r.annee === anneeN - 1) caN1[r.mois - 1] = r.ca;
    }

    return {
      commandes: commandes.map((c) => ({
        id: c.id,
        numero: c.numero,
        typeCmd: c.typeCmd,
        dateCommande: c.dateCommande,
        annulee: c.dateAnnulation !== null,
        idRepr: c.idRepr,
        viaMobile: c.idCommandeApk !== null,
        nbLignes: c.lignes.length,
        total: c.lignes.reduce((s, l) => s + Number(l.montant), 0),
      })),
      visites,
      ca: { anneeN, courbeN: caN, courbeN1: caN1 },
    };
  }

  // --- Contacts (CRM, jamais touchés par l'import Minos) -----------------

  async addContact(clientId: string, dto: CreateContactDto, creeParId: string) {
    await this.findOne(clientId); // 404 si le client n'existe pas
    return this.prisma.clientContact.create({
      data: { ...dto, clientId, creeParId },
    });
  }

  async updateContact(clientId: string, contactId: string, dto: UpdateContactDto) {
    const contact = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId, deletedAt: null },
    });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} introuvable pour ce client`);
    }
    return this.prisma.clientContact.update({ where: { id: contactId }, data: dto });
  }

  async removeContact(clientId: string, contactId: string) {
    const contact = await this.prisma.clientContact.findFirst({
      where: { id: contactId, clientId, deletedAt: null },
    });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} introuvable pour ce client`);
    }
    await this.prisma.clientContact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
    });
    return { id: contactId, deleted: true };
  }

  // --- Notes terrain (CRM, jamais touchées par l'import Minos) -----------

  async addNote(clientId: string, remarque: string, auteurId: string, idApk?: string) {
    await this.findOne(clientId); // 404 si le client n'existe pas
    // Idempotence : l'outbox mobile peut rejouer la même note sans doublon.
    if (idApk) {
      const existante = await this.prisma.clientNote.findFirst({
        where: { idApk, deletedAt: null },
        select: {
          id: true,
          remarque: true,
          createdAt: true,
          auteur: { select: { displayName: true } },
        },
      });
      if (existante) return existante;
    }
    return this.prisma.clientNote.create({
      data: { clientId, remarque, auteurId, idApk: idApk ?? null },
      select: {
        id: true,
        remarque: true,
        createdAt: true,
        auteur: { select: { displayName: true } },
      },
    });
  }

  /**
   * Fiches du portefeuille pour la réplication mobile : contacts et notes de
   * chaque magasin en UN appel (un commercial ne reçoit que SES magasins).
   */
  async findFiches(user?: { role: string; idRepr: string | null }) {
    const mine =
      user?.role === 'COMMERCIAL' && user.idRepr ? idReprVariants(user.idRepr) : null;
    return this.prisma.client.findMany({
      where: {
        deletedAt: null,
        ...(mine
          ? { OR: [{ idCommercial1: { in: mine } }, { idCommercial2: { in: mine } }] }
          : {}),
      },
      select: {
        id: true,
        contacts: {
          where: { deletedAt: null },
          orderBy: [{ nom: 'asc' }],
          select: {
            id: true,
            prenom: true,
            nom: true,
            poste: true,
            fixe: true,
            portable: true,
            mail: true,
          },
        },
        notes: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            remarque: true,
            createdAt: true,
            idApk: true,
            auteur: { select: { displayName: true } },
          },
        },
      },
    });
  }

  async removeNote(clientId: string, noteId: string) {
    const note = await this.prisma.clientNote.findFirst({
      where: { id: noteId, clientId, deletedAt: null },
    });
    if (!note) {
      throw new NotFoundException(`Note ${noteId} introuvable pour ce client`);
    }
    await this.prisma.clientNote.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
    return { id: noteId, deleted: true };
  }

  // --- Périodicité de visite (CRM) ---------------------------------------

  /** Nomenclature des périodicités actives (référentiel legacy 1..6). */
  listPeriodicites() {
    return this.prisma.periodicite.findMany({
      where: { actif: true },
      select: { id: true, code: true, libelle: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Remplace la périodicité du client (null = aucune). Historique conservé en soft delete. */
  async setPeriodicite(clientId: string, periodiciteId: string | null, affecteParId: string) {
    await this.findOne(clientId);
    if (periodiciteId) {
      const ref = await this.prisma.periodicite.findFirst({ where: { id: periodiciteId, actif: true } });
      if (!ref) {
        throw new NotFoundException(`Périodicité ${periodiciteId} introuvable`);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.clientPeriodicite.updateMany({
        where: { clientId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (!periodiciteId) return { clientId, periodicite: null };
      const cree = await tx.clientPeriodicite.create({
        data: { clientId, periodiciteId, affecteParId },
        select: { id: true, periodicite: { select: { code: true, libelle: true } } },
      });
      return { clientId, periodicite: cree };
    });
  }

  async create(dto: CreateClientDto) {
    try {
      return await this.prisma.client.create({ data: dto });
    } catch (err) {
      throw this.handleUniqueError(err, dto.codeAs400);
    }
  }

  async update(id: string, dto: UpdateClientDto) {
    await this.findOne(id);
    try {
      return await this.prisma.client.update({ where: { id }, data: dto });
    } catch (err) {
      throw this.handleUniqueError(err, dto.codeAs400);
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.client.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id, deleted: true };
  }

  private handleUniqueError(err: unknown, codeAs400?: string) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(`Un client avec le codeAs400 "${codeAs400}" existe déjà`);
    }
    return err;
  }
}
