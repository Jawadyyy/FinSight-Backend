import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Saves us from writing `@Request() req` and then `req.user` in every controller.
 *
 *   @Get('me')
 *   getMe(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * Whatever the passport strategy returned from `validate()` ends up here.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: unknown }>();
    return request.user;
  },
);
