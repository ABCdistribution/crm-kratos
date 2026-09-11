import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { PrismaService } from '../prisma/prisma.service';
import { parseFixedWidth } from './fixed-width-parser';
import { clientFieldSpec } from './mappings/client.mapping';
import { clientRowSchema, toMinosClientData } from './mappings/client.schema';

interface MinosJobData {
  logId: string;
  filePath: string;
}

/**
 * Worker BullMQ d'import Minos.
 * Optimisé : streaming ligne par ligne, validation Zod, upsert par lots.
 * L'upsert ne met à jour QUE les champs Minos → les champs CRM ne sont jamais écrasés
 * (fin du vidage/réinsertion nocturne du legacy).
 */
@Processor('minos-import')
export class MinosImportProcessor extends WorkerHost {
  private readonly logger = new Logger(MinosImportProcessor.name);
  private readonly batchSize = 500;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<MinosJobData>): Promise<{ total: number; ok: number; failed: number }> {
    const { logId, filePath } = job.data;
    await this.prisma.erpImportLog.update({
      where: { id: logId },
      data: { status: 'PROCESSING', startedAt: new Date() },
    });

    let total = 0;
    let ok = 0;
    let failed = 0;
    const errors: string[] = [];
    let batch: ReturnType<typeof toMinosClientData>[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await this.prisma.$transaction(
        rows.map((data) =>
          this.prisma.client.upsert({
            where: { codeAs400: data.codeAs400 },
            create: data, // champs Minos ; les champs CRM prennent leurs valeurs par défaut
            update: data, // champs Minos UNIQUEMENT — CRM (actif, niveauClass, secteur…) intouchés
          }),
        ),
      );
    };

    try {
      // AS400 : fichiers encodés en latin1 (ISO-8859-1) — accents français corrects.
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'latin1' }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (line.trim().length === 0) continue;
        total++;
        const raw = parseFixedWidth(line, clientFieldSpec);
        const parsed = clientRowSchema.safeParse(raw);
        if (!parsed.success) {
          failed++;
          if (errors.length < 50) {
            errors.push(`L${total}: ${parsed.error.issues[0]?.message ?? 'ligne invalide'}`);
          }
          continue;
        }
        batch.push(toMinosClientData(parsed.data));
        ok++;
        if (batch.length >= this.batchSize) await flush();
        if (total % 5000 === 0) await job.updateProgress(total);
      }
      await flush();
    } catch (err) {
      await this.prisma.erpImportLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED',
          rowsTotal: total,
          rowsOk: ok,
          rowsFailed: failed,
          finishedAt: new Date(),
          errorMessage: (err as Error).message,
        },
      });
      throw err;
    }

    const status = ok === 0 && failed > 0 ? 'FAILED' : 'SUCCESS';
    await this.prisma.erpImportLog.update({
      where: { id: logId },
      data: {
        status,
        rowsTotal: total,
        rowsOk: ok,
        rowsFailed: failed,
        finishedAt: new Date(),
        errorMessage: errors.length ? errors.join('\n') : null,
      },
    });
    this.logger.log(`Import ${logId} terminé : ${ok}/${total} OK, ${failed} échec(s)`);
    return { total, ok, failed };
  }
}
