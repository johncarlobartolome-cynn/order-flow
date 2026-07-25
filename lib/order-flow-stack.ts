import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

export class OrderFlowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Custom event bus (T6) -------------------------------------------
    const bus = new events.EventBus(this, 'OrderFlowBus', {
      eventBusName: 'order-flow-bus',
    });
    new cdk.CfnOutput(this, 'OrderFlowBusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'OrderFlowBusArn', { value: bus.eventBusArn });

    // --- Single-table store (T12) ----------------------------------------
    // Order status:   PK = ORDER#<orderId>   SK = STATUS#<consumer>
    // Inventory (E4): PK = PRODUCT#<sku>      SK = STOCK
    const table = new dynamodb.Table(this, 'OrderFlowTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // learning project: clean teardown
    });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });

    // --- Inventory queue + DLQ (T18) -------------------------------------
    // DLQ: messages that fail processing maxReceiveCount times land here instead
    // of vanishing. This is the "nothing disappears" safety net.
    const inventoryDlq = new sqs.Queue(this, 'InventoryDlq', {
      retentionPeriod: cdk.Duration.days(14),
    });

    // Main work queue: buffers OrderPlaced events for the inventory worker.
    // After 3 failed receives, a message is redriven to the DLQ.
    const inventoryQueue = new sqs.Queue(this, 'InventoryQueue', {
      // Production guidance is visibility >= 6x the fn timeout so a slow invocation
      // isn't retried mid-flight. Here the worker is fast (a single transaction) and
      // the forceFailure path throws in <100ms, and T23.1 made processing idempotent,
      // so a tight visibility is safe AND gives a snappy demo: ~3 receives x 10s =>
      // real DLQ landing in ~20-30s. A latency-variable prod worker would keep 6x.
      visibilityTimeout: cdk.Duration.seconds(10),
      deadLetterQueue: { queue: inventoryDlq, maxReceiveCount: 3 },
    });
    new cdk.CfnOutput(this, 'InventoryQueueUrl', { value: inventoryQueue.queueUrl });
    new cdk.CfnOutput(this, 'InventoryDlqUrl', { value: inventoryDlq.queueUrl });

    // --- Route OrderPlaced to the inventory queue (T19) ------------------
    // Buffered path: unlike email/analytics (direct Lambda targets), inventory
    // goes through SQS so failures are retried and captured by the DLQ.
    new events.Rule(this, 'InventoryOnOrderPlaced', {
      eventBus: bus,
      eventPattern: { source: ['orders.api'], detailType: ['OrderPlaced'] },
      targets: [new targets.SqsQueue(inventoryQueue)],
    });

    // --- Inventory worker (T21 wires the T20 handler) --------------------
    const inventoryFn = new NodejsFunction(this, 'ProcessInventoryFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/process-inventory/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(3),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(inventoryFn);

    // SQS triggers the worker. batchSize 1 = one order per invocation, so a poison
    // message fails alone and reaches the DLQ without dragging a whole batch down.
    inventoryFn.addEventSource(new SqsEventSource(inventoryQueue, { batchSize: 1 }));

    // --- DLQ consumer: turn a dead-letter into a real status signal (T36) --
    // The DLQ isn't a graveyard, it has its own consumer. When a poison message
    // lands here, this writes STATUS#inventory {status:'dead-letter'} so the UI
    // reflects ACTUAL state, not a client-side timer guess. It also drains the DLQ
    // (so the E2E asserts the status row, not queue depth). The DLQ keeps its
    // default 30s visibility, comfortably above this fn's 10s timeout.
    const processDlqFn = new NodejsFunction(this, 'ProcessDlqFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/process-dlq/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(processDlqFn);
    processDlqFn.addEventSource(new SqsEventSource(inventoryDlq, { batchSize: 1 }));


    // --- Producer Lambda + API (T8) --------------------------------------
    const createOrderFn = new NodejsFunction(this, 'CreateOrderFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/create-order/index.ts'),
      handler: 'handler',
      environment: { EVENT_BUS_NAME: bus.eventBusName },
    });

    // Least privilege: only events:PutEvents, only to our bus.
    bus.grantPutEventsTo(createOrderFn);

    const httpApi = new HttpApi(this, 'OrderFlowApi', {
      corsPreflight: {
        allowOrigins: ['*'], // public demo, public data; scope later if needed
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({
      path: '/orders',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateOrderIntegration', createOrderFn),
    });

    const getStatusFn = new NodejsFunction(this, 'GetOrderStatusFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/get-order-status/index.ts'),
      handler: 'handler',
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadData(getStatusFn);

    httpApi.addRoutes({
      path: '/orders/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('GetOrderStatusIntegration', getStatusFn),
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });

    // --- Audit rule: see events on the bus (T9) --------------------------
    const auditLog = new logs.LogGroup(this, 'OrderEventsAuditLog', {
      logGroupName: '/aws/events/order-flow-audit',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, 'AuditAllOrderEvents', {
      eventBus: bus,
      eventPattern: { source: ['orders.api'] },
      targets: [new targets.CloudWatchLogGroup(auditLog)],
    });

    // --- Fan-out consumers (T15) -----------------------------------------
    const emailFn = new NodejsFunction(this, 'NotifyEmailFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/notify-email/index.ts'),
      handler: 'handler',
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(emailFn);

    const analyticsFn = new NodejsFunction(this, 'RecordAnalyticsFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda/record-analytics/index.ts'),
      handler: 'handler',
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(analyticsFn);

    // One rule per consumer: each subscribes to OrderPlaced independently.
    new events.Rule(this, 'EmailOnOrderPlaced', {
      eventBus: bus,
      eventPattern: { source: ['orders.api'], detailType: ['OrderPlaced'] },
      targets: [new targets.LambdaFunction(emailFn)],
    });

    new events.Rule(this, 'AnalyticsOnOrderPlaced', {
      eventBus: bus,
      eventPattern: { source: ['orders.api'], detailType: ['OrderPlaced'] },
      targets: [new targets.LambdaFunction(analyticsFn)],
    });

    // --- CI/CD: keyless GitHub Actions deploy role (T25) -----------------
    // Reference the account's EXISTING GitHub OIDC provider (one per account).
    const githubOidc = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    // ^^ If step 0 showed NO provider, replace the three lines above with:
    //    const githubOidc = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
    //      url: 'https://token.actions.githubusercontent.com',
    //      clientIds: ['sts.amazonaws.com'],
    //    });

    // Role GitHub Actions assumes: ONLY from this repo's main branch. No stored keys.
    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'order-flow-github-deploy',
      description: 'GitHub Actions OIDC role: cdk deploy + E2E reads for order-flow',
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidc, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          // GitHub injects immutable IDs into the sub: owner@<ownerId>/repo@<repoId>.
          // Verified from the rejected token via CloudTrail. Plain repo:owner/repo
          // does NOT match. These numeric IDs are rename-proof, so pinning them is safe.
          'token.actions.githubusercontent.com:sub':
            'repo:johncarlobartolome-cynn@211265861/order-flow@1311318161:ref:refs/heads/main',
        },
      }),
    });

    // cdk deploy works by assuming the CDK bootstrap roles.
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
    }));

    // Least-privilege reads the post-deploy E2E test needs.
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${this.stackName}/*`],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [table.tableArn],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'],
      resources: [inventoryDlq.queueArn],
    }));

    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: deployRole.roleArn });

    // --- Web demo hosting: private S3 + CloudFront (OAC) (T33) ------------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // private; only CloudFront reads it
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket), // OAC, not public
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [ // SPA fallback
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // Upload the built SPA only when it exists, so `npm test`/synth don't require a build.
    const webDist = path.join(__dirname, '../web/dist');
    if (fs.existsSync(webDist)) {
      new BucketDeployment(this, 'DeployWeb', {
        sources: [Source.asset(webDist)],
        destinationBucket: siteBucket,
        distribution,
        distributionPaths: ['/*'],
      });
    }

    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });

  }
}
