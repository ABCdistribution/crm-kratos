import { Module } from '@nestjs/common';
import { PlanningsController, PlannificationsController } from './plannings.controller';
import { PlanningsService } from './plannings.service';

@Module({
  controllers: [PlanningsController, PlannificationsController],
  providers: [PlanningsService],
  exports: [PlanningsService], // le dashboard matérialise les occurrences du jour
})
export class PlanningsModule {}
