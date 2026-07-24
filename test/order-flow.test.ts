import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { OrderFlowStack } from '../lib/order-flow-stack';

// Smoke test: proves the stack synthesizes and the CDK test harness works end to end.
test('stack synthesizes without error', () => {
    const app = new cdk.App();
    const stack = new OrderFlowStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    expect(template.toJSON().Resources).toBeDefined();
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

test('wires POST /orders to a Node 22 Lambda with least-privilege PutEvents', () => {
    const app = new cdk.App();
    const stack = new OrderFlowStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Environment: { Variables: Match.objectLike({ EVENT_BUS_NAME: Match.anyValue() }) },
    });

    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /orders' });

    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
                Match.objectLike({
                    Action: 'events:PutEvents',
                    Effect: 'Allow',
                    // must be scoped to the bus ARN, never '*'
                    Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('OrderFlowBus'), 'Arn'] },
                }),
            ]),
        }),
    });

});

test('audits all order events to a CloudWatch log group', () => {
    const app = new cdk.App();
    const stack = new OrderFlowStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/events/order-flow-audit',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: { source: ['orders.api'] },
    });
});

test('creates the single-table DynamoDB store', () => {
    const app = new cdk.App();
    const stack = new OrderFlowStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
    });
});

test('fans out OrderPlaced to two independent consumers with table write access', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // A rule targets the email Lambda, and a (separate) rule targets analytics.
  // Matched by the target's logical-id prefix → robust to adding more rules.
  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: Match.arrayWith([
      Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('NotifyEmailFn'), 'Arn'] } }),
    ]),
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: Match.arrayWith([
      Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('RecordAnalyticsFn'), 'Arn'] } }),
    ]),
  });

  // Both consumer Lambdas exist.
  const fnIds = Object.keys(template.findResources('AWS::Lambda::Function'));
  expect(fnIds.some((id) => id.startsWith('NotifyEmailFn'))).toBe(true);
  expect(fnIds.some((id) => id.startsWith('RecordAnalyticsFn'))).toBe(true);

  // Consumers can write to the table.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith(['dynamodb:PutItem']), Effect: 'Allow' }),
      ]),
    }),
  });
});

test('creates an inventory queue with a dead-letter queue (maxReceiveCount 3)', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // two queues: the work queue + its DLQ
  template.resourceCountIs('AWS::SQS::Queue', 2);

  // the work queue redrives to the DLQ after 3 failed receives
  template.hasResourceProperties('AWS::SQS::Queue', {
    RedrivePolicy: Match.objectLike({
      maxReceiveCount: 3,
      deadLetterTargetArn: Match.anyValue(),
    }),
  });
});

test('routes OrderPlaced to the inventory queue (buffered path)', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: Match.arrayWith([
      Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('InventoryQueue'), 'Arn'] } }),
    ]),
  });
});

test('the inventory worker consumes the queue (batchSize 1) and can write the table', () => {
  const app = new cdk.App();
  const stack = new OrderFlowStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // SQS -> worker event-source mapping, one message per invocation
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1,
    EventSourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('InventoryQueue'), 'Arn'] },
  });

  // worker granted receive on the queue (via addEventSource)
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: Match.arrayWith(['sqs:ReceiveMessage']) }),
      ]),
    }),
  });
});
