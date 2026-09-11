import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@crm/database';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProspectsService } from './prospects.service';
import {
  CreateProspectApkDto,
  CreateProspectDto,
  QueryProspectsDto,
  UpdateProspectDto,
} from './dto/prospect.dto';

/**
 * Prospection & pipeline (module Helios).
 * Matrice de rôles : CS = secteur, DR = région, Direction = lecture globale,
 * ADMIN = tout. Détail par route via @Roles + scoping dans le service.
 */
@ApiTags('prospection')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('prospects')
export class ProspectsController {
  constructor(private readonly prospects: ProspectsService) {}

  @Get()
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.DIRECTION, Role.ADMIN)
  @ApiOperation({
    summary:
      'Liste paginée des prospects (search, secteur, statut, assignedTo) — scopée : CS = ses secteurs, DR = sa région, Direction/ADMIN = tout',
  })
  findAll(@Query() query: QueryProspectsDto, @CurrentUser() user: User) {
    return this.prospects.findAll(user, query);
  }

  @Get('pipeline')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.DIRECTION, Role.ADMIN)
  @ApiOperation({
    summary:
      'Pipeline : prospects groupés par étape (vue Kanban), avec total et valeur pondérée (CA potentiel × probabilité) par colonne',
  })
  pipeline(@CurrentUser() user: User) {
    return this.prospects.pipeline(user);
  }

  @Post()
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.ADMIN)
  @ApiOperation({ summary: 'Créer un prospect (CS · DR) — assigné au créateur par défaut' })
  create(@Body() dto: CreateProspectDto, @CurrentUser() user: User) {
    return this.prospects.create(user, dto);
  }

  @Post('apk')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.ADMIN)
  @ApiOperation({
    summary:
      "Créer un prospect depuis le mobile (offline) — idempotent par idApk : l'outbox peut rejouer sans doublon",
  })
  createApk(@Body() dto: CreateProspectApkDto, @CurrentUser() user: User) {
    return this.prospects.createApk(user, dto);
  }

  @Get(':id')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.DIRECTION, Role.ADMIN)
  @ApiOperation({ summary: 'Fiche prospect (coordonnées, contacts, notes) — 404 hors périmètre' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.prospects.findOne(user, id);
  }

  @Get(':id/historique')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.DIRECTION, Role.ADMIN)
  @ApiOperation({ summary: 'Timeline du prospect : visites de prospection et opportunités, antéchronologique' })
  historique(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.prospects.historique(user, id);
  }

  @Patch(':id')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.ADMIN)
  @ApiOperation({
    summary:
      "Éditer / faire avancer l'étape — un changement d'étape applique la probabilité par défaut (sauf fournie) ; motifPerte requis pour PERDU",
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProspectDto,
    @CurrentUser() user: User,
  ) {
    return this.prospects.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(Role.DIRECTEUR_REGIONAL, Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer un prospect (soft delete) — DR · ADMIN' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.prospects.remove(user, id);
  }

  @Post(':id/convert')
  @Roles(Role.CHEF_SECTEUR, Role.DIRECTEUR_REGIONAL, Role.ADMIN)
  @ApiOperation({
    summary:
      'Convertir en client (idempotent) : crée le Client depuis le prospect (codeAs400 provisoire PRSP-xxxxxxxx), y rattache contacts/notes/visites/opportunités, statut → GAGNE',
  })
  convert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.prospects.convert(user, id);
  }
}
