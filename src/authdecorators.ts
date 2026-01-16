import { getCurrentContextStore } from './context';
import { SolidActions } from './solidactions';
import {
  ClassAuthDefaults,
  SOLIDACTIONS_AUTH,
  SolidActionsMethodMiddlewareInstaller,
  MethodAuth,
  MethodRegistrationBase,
  registerMiddlewareInstaller,
} from './decorators';
import { SolidActionsNotAuthorizedError } from './error';

function checkMethodAuth(methReg: MethodRegistrationBase, args: unknown[]) {
  // Validate the user authentication and populate the role field
  const requiredRoles = methReg.getRequiredRoles();
  if (requiredRoles.length > 0) {
    SolidActions.span?.setAttribute('requiredRoles', requiredRoles);
    const curRoles = SolidActions.authenticatedRoles;
    let authorized = false;
    const set = new Set(curRoles);
    for (const role of requiredRoles) {
      if (set.has(role)) {
        authorized = true;
        if (getCurrentContextStore()) {
          getCurrentContextStore()!.assumedRole = role;
        }
        break;
      }
    }
    if (!authorized) {
      const err = new SolidActionsNotAuthorizedError(
        `User does not have a role with permission to call ${methReg.name}`,
        403,
      );
      SolidActions.span?.addEvent('SolidActionsNotAuthorizedError', { message: err.message });
      throw err;
    }
  }

  return args;
}

class AuthChecker implements SolidActionsMethodMiddlewareInstaller {
  installMiddleware(methReg: MethodRegistrationBase): void {
    const classAuth = methReg?.defaults?.getRegisteredInfo(SOLIDACTIONS_AUTH) as ClassAuthDefaults;
    const methodAuth = methReg?.getRegisteredInfo(SOLIDACTIONS_AUTH) as MethodAuth;

    const shouldCheck = classAuth?.requiredRole !== undefined || methodAuth?.requiredRole !== undefined;

    if (shouldCheck) {
      methReg.addEntryInterceptor(checkMethodAuth, 10);
    }
  }
}

const authChecker = new AuthChecker();

export function registerAuthChecker() {
  registerMiddlewareInstaller(authChecker);
}
