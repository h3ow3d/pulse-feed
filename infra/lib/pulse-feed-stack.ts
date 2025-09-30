import * as path from 'path';
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

// DynamoDB
import {
  Table,
  AttributeType,
  BillingMode,
  StreamViewType,
} from 'aws-cdk-lib/aws-dynamodb';

// Lambda
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

// SSM Param
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

// EventBridge (schedule)
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';

// SQS
import { Queue } from 'aws-cdk-lib/aws-sqs';

// S3
import {
  Bucket,
  BlockPublicAccess,
  EventType as S3EventType,
} from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';

// Pipes (DDB stream -> SQS)
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';

// IAM
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';

// CloudWatch
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Metric } from 'aws-cdk-lib/aws-cloudwatch';
import { LogGroup } from 'aws-cdk-lib/aws-logs';

export class PulseFeedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------------- DynamoDB: Posts (with Streams) ----------------
    const posts = new Table(this, 'PulseFeedPosts', {
      partitionKey: { name: 'feed_id', type: AttributeType.STRING },
      sortKey: { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY
    });

    // ---------------- DynamoDB: Summaries ----------------
    const summaries = new Table(this, 'PulseFeedSummaries', {
      partitionKey: { name: 'post_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY
    });

    // ---------------- SSM Parameter: Feeds list ----------------
    const feedsParam = new StringParameter(this, 'PulseFeedFeedsParam', {
      parameterName: '/pulse-feed/feeds',
      stringValue: JSON.stringify([
        'https://aws.amazon.com/blogs/aws/feed/',
        'https://news.ycombinator.com/rss',
      ]),
    });

    // ---------------- S3: Raw Content Bucket ----------------
    const rawBucket = new Bucket(this, 'PulseFeedRawContent', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true, // creates custom resource under the hood
      removalPolicy: RemovalPolicy.DESTROY, // DEV ONLY
    });

    // ---------------- SQS: ToFetch + DLQ ----------------
    const toFetchDlq = new Queue(this, 'PulseFeedToFetchDLQ', {});

    const toFetch = new Queue(this, 'PulseFeedToFetch', {
      // Visibility must be >= the Lambda timeout (60s). Give buffer.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: toFetchDlq, maxReceiveCount: 5 },
    });


    // ---------------- Lambda: Ingest (EventBridge schedule) ----------------
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

    const ingestRule = new Rule(this, 'PulseFeedIngestSchedule', {
      schedule: Schedule.rate(Duration.minutes(15)),
      targets: [new LambdaFunction(ingest)],
    });

    // ---------------- Lambda: Fetcher (SQS -> S3 text.txt) ----------------
    const fetcher = new NodejsFunction(this, 'PulseFeedFetcher', {
      functionName: 'PulseFeedFetcher',
      entry: path.join(__dirname, '../../src/fetcher/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(60),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
      },
    });
    fetcher.addEventSource(new SqsEventSource(toFetch, { batchSize: 5 }));
    rawBucket.grantWrite(fetcher);

    // ---------------- Lambda: Summariser (S3 text.txt -> Bedrock -> summary.json & DDB) ----------------
    const summariser = new NodejsFunction(this, 'PulseFeedsummariser', {
      functionName: 'PulseFeedsummariser',
      entry: path.join(__dirname, '../../src/summariser/handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: Duration.seconds(60),
      tracing: Tracing.ACTIVE,
      bundling: { minify: true, sourcesContent: false },
      environment: {
        RAW_BUCKET: rawBucket.bucketName,
        SUMMARIES_TABLE: summaries.tableName, // ensure present
        BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
        BEDROCK_REGION: Stack.of(this).region,
        SUMMARY_CHAR_LIMIT: '280',
        // SKIP_BEDROCK: 'true', // optional fallback during dev
      },
    });
    rawBucket.grantRead(summariser);
    rawBucket.grantWrite(summariser); // allow summary.json
    summaries.grantWriteData(summariser);

    // Bedrock invoke permission
    summariser.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'], // scope down to specific model ARN if you prefer
      }),
    );

    // S3 -> Lambda notification on *.text.txt
    rawBucket.addEventNotification(
      S3EventType.OBJECT_CREATED,
      new LambdaDestination(summariser),
      { suffix: 'text.txt' },
    );

    // ---------------- EventBridge Pipes: DDB stream -> SQS ----------------
    const pipeRole = new Role(this, 'PulseFeedPipeRole', {
      assumedBy: new ServicePrincipal('pipes.amazonaws.com'),
    });
    pipeRole.addToPolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
          'dynamodb:ListStreams',
        ],
        resources: [posts.tableStreamArn!],
      }),
    );
    pipeRole.addToPolicy(
      new PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [toFetch.queueArn],
      }),
    );

    const PIPE_FIXED_NAME = 'PulseFeedDdbToSqsPipe';
    const pipe = new CfnPipe(this, 'PulseFeedDdbToSqsPipe', {
      name: PIPE_FIXED_NAME, // give it a stable name for metrics
      roleArn: pipeRole.roleArn,
      source: posts.tableStreamArn!,
      target: toFetch.queueArn,
      sourceParameters: {
        filterCriteria: { filters: [{ pattern: '{"eventName":["INSERT"]}' }] },
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 10,
        },
      },
      targetParameters: { sqsQueueParameters: {} },
    });

    // ---------------- CloudWatch Dashboard ----------------
    const dash = new cloudwatch.Dashboard(this, 'PulseFeedDashboard', {
      dashboardName: 'PulseFeed',
    });

    // Title
    dash.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PulseFeed – Ops Overview',
        width: 24,
        height: 1,
      }),
    );

    // Lambdas: Invocations & Errors
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda: Invocations (L) & Errors (R)',
        left: [
          ingest.metricInvocations(),
          fetcher.metricInvocations(),
          summariser.metricInvocations(),
        ],
        right: [
          ingest.metricErrors(),
          fetcher.metricErrors(),
          summariser.metricErrors(),
        ],
        width: 24,
        height: 6,
      }),
    );

    // Lambdas: p95 + Throttles
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda p95 Duration (ms)',
        left: [
          ingest.metricDuration({ statistic: 'p95' }),
          fetcher.metricDuration({ statistic: 'p95' }),
          summariser.metricDuration({ statistic: 'p95' }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        left: [
          ingest.metricThrottles(),
          fetcher.metricThrottles(),
          summariser.metricThrottles(),
        ],
        width: 12,
        height: 6,
      }),
    );

    // EventBridge rule metrics
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'EventBridge: Ingest Rule',
        left: [
          new Metric({
            namespace: 'AWS/Events',
            metricName: 'Invocations',
            dimensionsMap: { RuleName: ingestRule.ruleName },
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        right: [
          new Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: ingestRule.ruleName },
            statistic: 'Sum',
            period: Duration.minutes(5),
          }),
        ],
        width: 24,
        height: 6,
      }),
    );

    // SQS queue metrics
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS ToFetch: Visible/NotVisible (L) & Age of Oldest (R)',
        left: [
          toFetch.metricApproximateNumberOfMessagesVisible(),
          toFetch.metricApproximateNumberOfMessagesNotVisible(),
        ],
        right: [toFetch.metricApproximateAgeOfOldestMessage()],
        width: 24,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS DLQ: Visible',
        left: [toFetchDlq.metricApproximateNumberOfMessagesVisible()],
        width: 24,
        height: 3,
      }),
    );

    // DDB metrics
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DDB: Posts – RCU/WCU & Throttles',
        left: [
          posts.metricConsumedReadCapacityUnits(),
          posts.metricConsumedWriteCapacityUnits(),
        ],
        right: [posts.metricThrottledRequests()],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DDB: Summaries – RCU/WCU & Throttles',
        left: [
          summaries.metricConsumedReadCapacityUnits(),
          summaries.metricConsumedWriteCapacityUnits(),
        ],
        right: [summaries.metricThrottledRequests()],
        width: 12,
        height: 6,
      }),
    );

    // S3 storage metrics (daily refresh) — use explicit Metric
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'S3 RawContent – Objects & Size (daily metrics)',
        left: [
          new Metric({
            namespace: 'AWS/S3',
            metricName: 'NumberOfObjects',
            dimensionsMap: {
              BucketName: rawBucket.bucketName,
              StorageType: 'AllStorageTypes',
            },
            statistic: 'Average',
            period: Duration.hours(6),
          }),
        ],
        right: [
          new Metric({
            namespace: 'AWS/S3',
            metricName: 'BucketSizeBytes',
            dimensionsMap: {
              BucketName: rawBucket.bucketName,
              StorageType: 'StandardStorage',
            },
            statistic: 'Average',
            period: Duration.hours(6),
          }),
        ],
        width: 24,
        height: 6,
      }),
    );

    // Pipes metrics — reference the fixed name we set on the pipe
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'EventBridge Pipes: Incoming / Outgoing / Filtered',
        left: [
          new Metric({
            namespace: 'AWS/Pipes',
            metricName: 'IncomingRecords',
            dimensionsMap: { PipeName: PIPE_FIXED_NAME },
            statistic: 'Sum',
          }),
          new Metric({
            namespace: 'AWS/Pipes',
            metricName: 'OutgoingRecords',
            dimensionsMap: { PipeName: PIPE_FIXED_NAME },
            statistic: 'Sum',
          }),
          new Metric({
            namespace: 'AWS/Pipes',
            metricName: 'FilteredRecords',
            dimensionsMap: { PipeName: PIPE_FIXED_NAME },
            statistic: 'Sum',
          }),
        ],
        width: 24,
        height: 6,
      }),
    );

    // Logs Insights widget: recent errors
    const ingestLG = LogGroup.fromLogGroupName(
      this,
      'LGIngest',
      `/aws/lambda/${ingest.functionName}`,
    );
    const fetcherLG = LogGroup.fromLogGroupName(
      this,
      'LGFetcher',
      `/aws/lambda/${fetcher.functionName}`,
    );
    const summariserLG = LogGroup.fromLogGroupName(
      this,
      'LGSummariser',
      `/aws/lambda/${summariser.functionName}`,
    );

    dash.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Lambda Errors (last 1h)',
        logGroupNames: [
          ingestLG.logGroupName,
          fetcherLG.logGroupName,
          summariserLG.logGroupName,
        ],
        queryLines: [
          'fields @timestamp, @log, @message',
          'filter @message like /ERROR|ValidationException|AccessDenied|Throttles|Task timed out/',
          'sort @timestamp desc',
          'limit 50',
        ],
        width: 24,
        height: 6,
      }),
    );

    // ---------------- Exports ----------------
    new CfnOutput(this, 'ExportPulseFeedPostsTableName', {
      value: posts.tableName,
      exportName: 'PulseFeedPostsTableName',
    });

    new CfnOutput(this, 'ExportPulseFeedSummariesTableName', {
      value: summaries.tableName,
      exportName: 'PulseFeedSummariesTableName',
    });

    new CfnOutput(this, 'ExportPulseFeedRawContentBucketName', {
      value: rawBucket.bucketName,
      exportName: 'PulseFeedRawContentBucketName',
    });

    new CfnOutput(this, 'ExportPulseFeedFeedsParamName', {
      value: feedsParam.parameterName,
      exportName: 'PulseFeedFeedsParamName',
    });
  }
}
