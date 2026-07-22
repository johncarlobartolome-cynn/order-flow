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

    // The two consumer Lambdas, identified by their TABLE_NAME env.
    // (Not a total count: the CloudWatchLogGroup audit target adds a hidden helper Lambda.)
    const consumerFns = template.findResources('AWS::Lambda::Function', {
        Properties: { Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue() }) } },
    });
    expect(Object.keys(consumerFns)).toHaveLength(2);

    // 3 rules total: audit (source only) + the two OrderPlaced consumer rules
    template.resourceCountIs('AWS::Events::Rule', 3);

    // exactly two rules match OrderPlaced
    const orderPlacedRules = template.findResources('AWS::Events::Rule', {
        Properties: { EventPattern: Match.objectLike({ 'detail-type': ['OrderPlaced'] }) },
    });
    expect(Object.keys(orderPlacedRules)).toHaveLength(2);

    // the two OrderPlaced rules must target two DISTINCT Lambdas
    const targetArns = Object.values(orderPlacedRules).map(
        (r: any) => JSON.stringify(r.Properties.Targets[0].Arn),
    );
    expect(new Set(targetArns).size).toBe(2);

    // consumers can write to the table (grantWriteData → includes dynamodb:PutItem)
    template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
                Match.objectLike({
                    Action: Match.arrayWith(['dynamodb:PutItem']),
                    Effect: 'Allow',
                }),
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