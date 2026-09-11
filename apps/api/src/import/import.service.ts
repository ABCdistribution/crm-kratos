import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { basename } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ImportService {
  constructor(
    @InjectQueue('minos-import') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /** Crée un log d'import et met le fichier clients en file d'attente (asynchrone). */
  async enqueueClients(filePath: string) {
    const fileName = basename(filePath);
    const log = await this.prisma.erpImportLog.create({
      data: { fileName, source: 'MINOS', status: 'PENDING' },
    });
    const job = await this.queue.add('client', { logId: log.id, filePath });
    return { logId: log.id, jobId: job.id, fileName, status: 'PENDING' };
  }

  async getLog(id: string) {
    const log = await this.prisma.erpImportLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Import introuvable');
    return log;
  }

  /** Journal des imports, du plus récent au plus ancien. */
  listLogs(limit = 50) {
    return this.prisma.erpImportLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
