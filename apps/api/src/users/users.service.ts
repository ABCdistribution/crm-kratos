import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@crm/database';
import { PrismaService } from '../prisma/prisma.service';
import { QueryUsersDto } from './dto/query-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/** Champs exposés d'un utilisateur (pas de données sensibles : l'auth est déléguée à l'AD). */
const userSelect = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  role: true,
  isActive: true,
  poste: true,
  idRepr: true,
  createdAt: true,
  secteurId: true,
  secteur: { select: { id: true, code: true, nom: true } },
  region: { select: { id: true, code: true, nom: true } },
  directeur: { select: { id: true, displayName: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryUsersDto, currentUser?: { id: string; role: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.UserWhereInput = {
      // Un chef de secteur ne voit que les utilisateurs rattachés à SES secteurs.
      ...(currentUser?.role === 'CHEF_SECTEUR'
        ? { secteur: { managerId: currentUser.id } }
        : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search, mode: 'insensitive' } },
              { displayName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: userSelect,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!user) throw new NotFoundException(`Utilisateur ${id} introuvable`);
    return user;
  }

  /**
   * Met à jour rôle / activation. `currentUserId` sert de garde-fou :
   * un admin ne peut pas se retirer son propre accès (dé-adminisation ou désactivation).
   */
  async update(id: string, dto: UpdateUserDto, currentUserId: string) {
    await this.findOne(id);

    if (id === currentUserId) {
      if (dto.isActive === false) {
        throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte.');
      }
      if (dto.role && dto.role !== Role.ADMIN) {
        throw new BadRequestException('Vous ne pouvez pas retirer votre propre rôle administrateur.');
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.secteurId !== undefined ? { secteurId: dto.secteurId } : {}),
      },
      select: userSelect,
    });
  }
}
