import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @ApiExcludeEndpoint()
  check(): { status: string } {
    return { status: 'UP' };
  }
}
