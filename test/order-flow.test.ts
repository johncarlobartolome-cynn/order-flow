import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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

