import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreationVisite {
  idApk: string;
  clientId: string;
  planningId?: string | null;
  motif?: string | null;
  dnAbc?: number | null;
  dnConcurrence?: number | null;
  dnGondoleHaute?: number | null;
  dnGondoleBasse?: number | null;
  commentaire?: string | null;
  reponses?: { questionId: string; valeur: string }[];
}

/**
 * Compte-rendu de visite remonté par l'app mobile (ou saisi plus tard sur le web).
 * Idempotent par `idApk` : l'outbox mobile peut rejouer sans créer de doublon.
 */
@Injectable()
export class VisitesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Visites du promoteur connecté, les plus récentes d'abord (paginées). */
  async findAll(promoteurId: string, opts: { page?: number; search?: string } = {}) {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const limit = 30;
    const where = {
      promoteurId,
      deletedAt: null,
      ...(opts.search
        ? {
            client: {
              OR: [
                { enseigne: { contains: opts.search, mode: 'insensitive' as const } },
                { ville: { contains: opts.search, mode: 'insensitive' as const } },
                { codeAs400: { contains: opts.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.visite.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          motif: true,
          dnAbc: true,
          dnConcurrence: true,
          dnGondoleHaute: true,
          dnGondoleBasse: true,
          pem: true,
          pmcCommentaire: true,
          client: { select: { id: true, codeAs400: true, enseigne: true, ville: true, niveauClass: true } },
          _count: { select: { photos: true } },
        },
      }),
      this.prisma.visite.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  async create(promoteur: { id: string }, dto: CreationVisite) {
    // Idempotence : la visite a peut-être déjà été synchronisée.
    const existante = await this.prisma.visite.findUnique({ where: { idApk: dto.idApk } });
    if (existante) {
      if (existante.promoteurId !== promoteur.id) {
        throw new ForbiddenException('Cet identifiant de visite appartient à un autre promoteur');
      }
      return { id: existante.id, idApk: dto.idApk, dejaSynchronisee: true };
    }

    const client = await this.prisma.client.findFirst({
      where: { id: dto.clientId, deletedAt: null },
    });
    if (!client) throw new NotFoundException(`Magasin ${dto.clientId} introuvable`);

    // La visite peut solder une visite planifiée — uniquement celle du promoteur.
    let planningId: string | null = null;
    if (dto.planningId) {
      const planning = await this.prisma.planning.findFirst({
        where: { id: dto.planningId, promoteurId: promoteur.id, deletedAt: null },
      });
      if (!planning) {
        throw new NotFoundException(`Visite planifiée ${dto.planningId} introuvable pour ce promoteur`);
      }
      planningId = planning.id;
    }

    // Ne garde que les réponses pointant vers des questions existantes.
    const reponses = dto.reponses ?? [];
    const questionsValides = reponses.length
      ? new Set(
          (
            await this.prisma.questionVisite.findMany({
              where: { id: { in: reponses.map((r) => r.questionId) }, deletedAt: null },
              select: { id: true },
            })
          ).map((q) => q.id),
        )
      : new Set<string>();

    const visite = await this.prisma.$transaction(async (tx) => {
      const creee = await tx.visite.create({
        data: {
          promoteurId: promoteur.id,
          clientId: dto.clientId,
          idApk: dto.idApk,
          motif: dto.motif?.trim() || null,
          dnAbc: dto.dnAbc ?? null,
          dnConcurrence: dto.dnConcurrence ?? null,
          dnGondoleHaute: dto.dnGondoleHaute ?? null,
          dnGondoleBasse: dto.dnGondoleBasse ?? null,
          pmcCommentaire: dto.commentaire?.trim() || null,
        },
      });
      if (questionsValides.size > 0) {
        await tx.visiteReponse.createMany({
          data: reponses
            .filter((r) => questionsValides.has(r.questionId))
            .map((r) => ({ visiteId: creee.id, questionId: r.questionId, valeur: r.valeur })),
          skipDuplicates: true,
        });
      }
      if (planningId) {
        await tx.planning.update({ where: { id: planningId }, data: { fait: true } });
      }
      return creee;
    });

    return { id: visite.id, idApk: dto.idApk, dejaSynchronisee: false };
  }
}
