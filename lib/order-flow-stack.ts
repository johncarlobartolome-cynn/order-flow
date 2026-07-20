import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class OrderFlowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

  // Custom event bus: isolates this app's events from the account default bus.
  // The producer Lambda (T7) will PutEvents here; rules (E3/E4) route OrderPlaced to consumers.
  const bus = new events.EventBus(this, 'OrderFlowBus', {
    eventBusName: 'order-flow-bus',
  });

  // Outputs make the bus easy to find from the CLI + wire up later.
  new cdk.CfnOutput(this, 'OrderFlowBusName', { value: bus.eventBusName });
  new cdk.CfnOutput(this, 'OrderFlowBusArn', { value: bus.eventBusArn });

  }
}
