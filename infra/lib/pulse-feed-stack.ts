// infra/lib/pulse-feed-stack.ts
import * as path from 'node:path';
import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Table, AttributeType, BillingMode, StreamViewType
} from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';

export class PulseFeedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB: posts table (Streams enabled)
    const posts = new Table(this, 'PulseFeedPosts', {
      partitionKey: { name: 'feed_id', type: AttributeType.STRING },
      sortKey:      { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: StreamViewType.NEW_IMAGE,                // <-- enable streams
      removalPolicy: RemovalPolicy.DESTROY,            // DEV ONLY
    });

    // SSM parameter for feed list
    const feedsParam = new StringParameter(this, 'PulseFeedFeedsParam', {
      parameterName: '/pulse-feed/feeds',
      stringValue: JSON.stringify([
        'https://aws.amazon.com/blogs/aws/feed/',
        'https://news.ycombinator.com/rss'
      ]),
    });

    // Ingest Lambda
    const ingest = new NodejsFunction(this, 'PulseFeedIngest', {
      functionName: 'PulseFeedIngest',
      entry: path.join(__dirname, '../../src/ingest/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        POSTS_TABLE: posts.tableName,
        FEEDS_PARAM: feedsParam.parameterName,
      },
    });

    posts.grantWriteData(ingest);
    feedsParam.grantRead(ingest);

    // Schedule every 15 minutes
    new Rule(this, 'PulseFeedIngestSchedule', {
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(ingest)],
    });

    // ---- Phase 3: CDC fan-out (Streams -> Pipe -> SQS) ----

    // SQS + DLQ
    const toFetchDlq = new Queue(this, 'PulseFeedToFetchDLQ', {});
    const toFetch = new Queue(this, 'PulseFeedToFetch', {
      queueName: 'PulseFeedToFetch',
      deadLetterQueue: { queue: toFetchDlq, maxReceiveCount: 5 },
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
    });

    // Pipes service role
    const pipeRole = new Role(this, 'PulseFeedPipeRole', {
      assumedBy: new ServicePrincipal('pipes.amazonaws.com'),
    });
    // DDB stream read permissions (you can scope to posts.tableStreamArn)
    pipeRole.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:DescribeStream','dynamodb:GetRecords','dynamodb:GetShardIterator','dynamodb:ListStreams'],
      resources: [posts.tableStreamArn!],
    }));
    // SQS send permission
    pipeRole.addToPolicy(new PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [toFetch.queueArn],
    }));

    // EventBridge Pipe: DDB Stream -> SQS (INSERT only)
    new CfnPipe(this, 'PulseFeedDdbToSqsPipe', {
      roleArn: pipeRole.roleArn,
      source: posts.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          // batchSize: 10, // optional
        },
        filterCriteria: {
          filters: [{ pattern: JSON.stringify({ eventName: ['INSERT'] }) }],
        },
      },
      target: toFetch.queueArn,
      targetParameters: {
        sqsQueueParameters: {}, // standard queue
      },
    });

    // Outputs
    this.exportValue(posts.tableName, { name: 'PulseFeedPostsTableName' });
    this.exportValue(feedsParam.parameterName, { name: 'PulseFeedFeedsParamName' });
    this.exportValue(toFetch.queueName, { name: 'PulseFeedToFetchName' });
    this.exportValue(toFetch.queueUrl,   { name: 'PulseFeedToFetchUrl' });
  }
}
