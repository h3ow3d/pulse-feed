// infra/lib/pulse-feed-stack.ts
import * as path from 'node:path';
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

export class PulseFeedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB: posts table
    const posts = new Table(this, 'PulseFeedPosts', {
      partitionKey: { name: 'feed_id', type: AttributeType.STRING },
      sortKey:      { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Use the new PITR API (avoids the deprecation warning)
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY; use RETAIN in prod
    });

    // SSM Parameter for feed list (JSON array)
    const feedsParam = new StringParameter(this, 'PulseFeedFeedsParam', {
      parameterName: '/pulse-feed/feeds',
      stringValue: JSON.stringify([
        'https://aws.amazon.com/blogs/aws/feed/',
        'https://news.ycombinator.com/rss'
      ]),
    });

    // Ingest Lambda (Node 20)
    const ingest = new NodejsFunction(this, 'PulseFeedIngest', {
      entry: path.join(__dirname, '../../src/ingest/handler.ts'), // TS source path (works with ts-node)
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      bundling: {
        externalModules: [], // default is fine for AWS SDK v3
      },
      environment: {
        POSTS_TABLE: posts.tableName,
        FEEDS_PARAM: feedsParam.parameterName,
      },
    });

    posts.grantWriteData(ingest);
    feedsParam.grantRead(ingest);

    // Run every 15 minutes
    new Rule(this, 'PulseFeedIngestSchedule', {
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(ingest)],
    });

    // Handy outputs
    this.exportValue(posts.tableName, { name: 'PulseFeedPostsTableName' });
    this.exportValue(feedsParam.parameterName, { name: 'PulseFeedFeedsParamName' });
  }
}
