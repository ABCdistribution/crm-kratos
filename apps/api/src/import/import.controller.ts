import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ImportService } from './import.service';
import { TriggerImportDto } from './dto/trigger-import.dto';

@ApiTags('import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('import/minos')
export class ImportController {
  constructor(private readonly service: ImportService) {}

  @Post('clients')
  @ApiOperation({ summary: 'Lance l’import Minos des clients (asynchrone via BullMQ)' })
  triggerClients(@Body() dto: TriggerImportDto) {
    return this.service.enqueueClients(dto.filePath);
  }

  @Get('logs')
  @ApiOperation({ summary: 'Journal des imports (les plus récents en premier)' })
  listLogs() {
    return this.service.listLogs();
  }

  @Get('logs/:id')
  @ApiOperation({ summary: 'État / résultat d’un import' })
  getLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLog(id);
  }
}
