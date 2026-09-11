import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@crm/database';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CommandesService } from './commandes.service';
import { CommandesApkService } from './commandes-apk.service';
import { CreateCommandeApkDto } from './dto/create-commande-apk.dto';
import { QueryCommandesDto } from './dto/query-commandes.dto';
import { QueryCommandesApkDto } from './dto/query-commandes-apk.dto';

@ApiTags('commandes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('commandes')
export class CommandesController {
  constructor(
    private readonly commandes: CommandesService,
    private readonly commandesApk: CommandesApkService,
  ) {}

  @Post('apk')
  @ApiOperation({
    summary:
      "Commande saisie sur l'app mobile — idempotente par idCommandeApk (pont IDCRM avec la future commande Minos)",
  })
  createApk(@Body() dto: CreateCommandeApkDto, @CurrentUser() me: User) {
    return this.commandesApk.create(me, dto);
  }

  // Déclarée avant GET :id pour ne pas être happée par le ParseUUIDPipe.
  @Get('apk')
  @ApiOperation({ summary: 'Commandes mobiles du promoteur connecté (la direction voit tout)' })
  findAllApk(@Query() query: QueryCommandesApkDto, @CurrentUser() me: User) {
    return this.commandesApk.findAll(me, query);
  }

  @Get('apk/:id')
  @ApiOperation({ summary: "Détail d'une commande mobile avec ses lignes" })
  findOneApk(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: User) {
    return this.commandesApk.findOne(me, id);
  }

  @Get()
  @ApiOperation({
    summary:
      'Liste paginée des commandes Minos (recherche, filtre annulées). Un commercial relié à un code représentant ne voit que les siennes.',
  })
  findAll(
    @Query() query: QueryCommandesDto,
    @CurrentUser() user: { role: string; idRepr: string | null },
  ) {
    return this.commandes.findAll(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: "Détail d'une commande avec ses lignes" })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.commandes.findOne(id);
  }
}
