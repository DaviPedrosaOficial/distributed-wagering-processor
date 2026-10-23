import { Injectable, type CanActivate, type ExecutionContext, } from "@nestjs/common";

/** Extensão explícita. NÃO autentica nem autoriza; ambiente do desafio somente.
 * Integração real: validar JWT de IdP externo (issuer, audience, assinatura/JWKS,
 * expiração), obter providerId de claim confiável e autorizar os recursos.
 * Nunca aceitar providerId do body como comprovação de identidade.
 * Health fica fora deste guard; SQS é canal interno com validação de domínio.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
