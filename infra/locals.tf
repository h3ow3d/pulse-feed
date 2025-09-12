data "aws_caller_identity" "current" {}

locals {
  project               = "pulse-feed"
  workspace             = terraform.workspace
  poller_service_name   = "${local.project}-${local.workspace}-poller"
}