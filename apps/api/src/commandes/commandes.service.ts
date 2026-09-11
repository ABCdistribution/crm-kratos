import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../prisma/prisma.service';
import { idReprVariants } from '../common/id-repr.util';
import { QueryCommandesDto } from './dto/query-commandes.dto';

@Injectable()
export class CommandesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryCommandesDto, user?: { role: string; idRepr: string | null }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Un commercial relié à un code représentant ne voit que SES commandes.
    const mine = user?.role === 'COMMERCIAL' && user.idRepr ? user.idRepr : null;

    const where: Prisma.CommandeWhereInput = {
      // Équivalence AD (« 68 ») ↔ Minos (« 068 ») gérée à la comparaison.
      ...(mine ? { idRepr: { in: idReprVariants(mine) } } : {}),
      ...(query.annulees === 'true' ? { dateAnnulation: { not: null } } : {}),
      ...(query.search
        ? {
            OR: [
              { numero: { contains: query.search, mode: 'insensitive' } },
              { raisonSocialeCmd: { contains: query.search, mode: 'insensitive' } },
              { client: { enseigne: { contains: query.search, mode: 'insensitive' } } },
              { client: { codeAs400: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.commande.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ dateCommande: 'desc' }, { numero: 'desc' }],
        select: {
          id: true,
          numero: true,
          typeCmd: true,
          dateCommande: true,
          dateAnnulation: true,
          raisonSocialeCmd: true,
          idRepr: true,
          client: { select: { id: true, codeAs400: true, enseigne: true } },
        },
      }),
      this.prisma.commande.count({ where }),
    ]);

    // Totaux et nombre de lignes agrégés en une requête pour la page courante.
    const ids = rows.map((r) => r.id);
    const sums = ids.length
      ? await this.prisma.commandeLigne.groupBy({
          by: ['commandeId'],
          where: { commandeId: { in: ids } },
          _sum: { montant: true },
          _count: { _all: true },
        })
      : [];
    const byId = new Map(sums.map((s) => [s.commandeId, s]));

    return {
      data: rows.map((r) => ({
        ...r,
        annulee: r.dateAnnulation !== null,
        nbLignes: byId.get(r.id)?._count._all ?? 0,
        total: Number(byId.get(r.id)?._sum.montant ?? 0),
      })),
      total,
      page,
      limit,
      scope: mine ? { type: 'mine' as const, idRepr: mine } : { type: 'global' as const, idRepr: null },
    };
  }

  async findOne(id: string) {
    const commande = await this.prisma.commande.findUnique({
      where: { id },
      select: {
        id: true,
        numero: true,
        typeCmd: true,
        dateCommande: true,
        dateAnnulation: true,
        raisonSocialeCmd: true,
        idRepr: true,
        idCommandeApk: true,
        client: { select: { id: true, codeAs400: true, enseigne: true, ville: true } },
        lignes: {
          orderBy: { noLigne: 'asc' },
          select: {
            id: true,
            noLigne: true,
            libelleArticle: true,
            quantite: true,
            montant: true,
            article: { select: { id: true, codeAs400: true, libelle: true } },
          },
        },
      },
    });
    if (!commande) {
      throw new NotFoundException(`Commande ${id} introuvable`);
    }
    return {
      ...commande,
      annulee: commande.dateAnnulation !== null,
      total: commande.lignes.reduce((s, l) => s + Number(l.montant), 0),
    };
  }
}
