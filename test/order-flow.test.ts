import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { OrderFlowStack } from '../lib/order-flow-stack';

// Smoke test: proves the CDK test harness works end to end.
// Nothing is built yet, so we assert zero app resources.
// This exercises the exact Template API we'll use for real in E2-E4.
test('stack synthesizes cleanly (no resources yet)', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::SQS::Queue', 0);
});

test('creates the custom EventBridge bus', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::Events::EventBus', 1);
  template.hasResourceProperties('AWS::Events::EventBus', {
    Name: 'order-flow-bus',
  });
});
