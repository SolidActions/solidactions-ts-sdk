import { SolidActions } from '@solidactions/sdk';

// There is nothing wrong with this class, but the usage will be bad...
export class ImproperlyLoadedClass {
  @SolidActions.workflow()
  static async justARegularWorkflow() {
    return Promise.resolve();
  }
}
