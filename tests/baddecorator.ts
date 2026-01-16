import { SolidActions } from '@solidactions/sdk';

export class BadDecoratorClass {
  @SolidActions.workflow()
  @SolidActions.step()
  static async cantBeBoth() {
    return Promise.resolve();
  }
}
