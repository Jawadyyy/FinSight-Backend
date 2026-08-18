import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Populates request.cookies, so the refresh strategy can read the refresh token.
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // credentials:true is required for the browser to send/receive the httpOnly
  // refresh cookie. origin:true reflects the caller's origin, which is allowed
  // alongside credentials (a literal '*' is not).
  app.enableCors({ origin: true, credentials: true });

  const config = new DocumentBuilder()
    .setTitle('FinSight Backend')
    .setDescription('AI Expense & Personal Finance Dashboard API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, config),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Swagger UI available at http://localhost:${port}/api/docs`);
}

void bootstrap();
