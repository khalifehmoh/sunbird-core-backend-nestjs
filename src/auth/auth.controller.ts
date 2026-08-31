import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  AuthResponseDto,
  ChangePasswordResponseDto,
  SessionResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
  ChangePasswordRequestDto,
} from './dto/auth.dto';
import { AuthCookieService, REFRESH_TOKEN_COOKIE } from './auth-cookie.service';
import { AuthService, type AuthSession } from './auth.service';
import { Public } from './public.decorator';
import { User } from '../database/entities/user.entity';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authCookies: AuthCookieService,
  ) {}

  @Post('register')
  @Public()
  @ApiCreatedResponse({ type: AuthResponseDto })
  async register(
    @Body() request: RegisterRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    return this.establishSession(
      response,
      await this.authService.register(request),
    );
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthResponseDto })
  async login(
    @Body() request: LoginRequestDto,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    return this.establishSession(
      response,
      await this.authService.login(
        request,
        httpRequest.ip,
        httpRequest.get('user-agent'),
      ),
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const cookies = request.cookies as
      Record<string, string | undefined> | undefined;
    return this.establishSession(
      response,
      await this.authService.refresh(
        cookies?.[REFRESH_TOKEN_COOKIE],
        request.ip,
        request.get('user-agent'),
      ),
    );
  }

  @Get('session')
  @ApiOkResponse({ type: SessionResponseDto })
  session(
    @Req() request: Request & { user: User },
  ): Promise<SessionResponseDto> {
    return this.authService.getSessionProfile(request.user);
  }

  @Put('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ChangePasswordResponseDto })
  async changePassword(
    @Req() req: Request & { user: User },
    @Body() dto: ChangePasswordRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChangePasswordResponseDto> {
    const result = await this.authService.changePassword(
      req.user,
      dto,
      req.ip,
      req.get('user-agent'),
    );
    this.authCookies.clearSession(response);
    return result;
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = request.cookies as
      Record<string, string | undefined> | undefined;
    await this.authService.logout(
      cookies?.[REFRESH_TOKEN_COOKIE],
      request.ip,
      request.get('user-agent'),
    );
    this.authCookies.clearSession(response);
  }

  private establishSession(
    response: Response,
    session: AuthSession,
  ): AuthResponseDto {
    this.authCookies.setSession(response, session);
    return session.response;
  }
}
