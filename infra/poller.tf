# --- IAM: Lambda assume role trust ---
data "aws_iam_policy_document" "poller_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- IAM: Lambda execution role ---
resource "aws_iam_role" "poller_role" {
  name               = "${local.poller_service_name}-role"
  assume_role_policy = data.aws_iam_policy_document.poller_lambda_assume.json
}

# --- IAM: CloudWatch Logs policy (minimal for now) ---
data "aws_iam_policy_document" "poller_logs" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "poller_logs" {
  name   = "${local.poller_service_name}-logs"
  role   = aws_iam_role.poller_role.id
  policy = data.aws_iam_policy_document.poller_logs.json
}

# --- Package code (expects repo_root/poller/*) ---
data "archive_file" "poller_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../poller"
  output_path = "${path.module}/../build/poller.zip"
}

# --- Lambda function ---
resource "aws_lambda_function" "poller" {
  function_name    = local.poller_service_name
  role             = aws_iam_role.poller_role.arn
  handler          = "main.lambda_handler"
  runtime          = "python3.12"

  filename         = data.archive_file.poller_zip.output_path
  source_code_hash = data.archive_file.poller_zip.output_base64sha256

  timeout = 30
  environment {
    variables = {
      PROJECT   = local.project
      WORKSPACE = local.workspace
    }
  }
}

# --- IAM: EventBridge Scheduler trust role ---
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "poller_scheduler_role" {
  name               = "${local.poller_service_name}-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

# --- IAM: Scheduler can invoke this Lambda ---
data "aws_iam_policy_document" "scheduler_invoke_pollers_lambda" {
  statement {
    effect = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.poller.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_invoke_pollers_lambda" {
  name   = "${local.poller_service_name}-invoke"
  role   = aws_iam_role.poller_scheduler_role.id
  policy = data.aws_iam_policy_document.scheduler_invoke_pollers_lambda.json
}

# --- EventBridge Scheduler (every 15 minutes) ---
resource "aws_scheduler_schedule" "poller_schedule" {
  name                = "${local.poller_service_name}-schedule"
  description         = "Invoke poller lambda every 15 minutes"
  schedule_expression = "rate(15 minutes)"

  flexible_time_window { mode = "OFF" }

  target {
    arn      = aws_lambda_function.poller.arn
    role_arn = aws_iam_role.poller_scheduler_role.arn
    input    = jsonencode({
      reason  = "scheduled",
      project = local.project,
      ws      = local.workspace
    })
  }
}