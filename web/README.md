# Archived PKG Web Client

Status: Archived on 2026-08-23.

This directory is a historical React client retained for reference while functionality is consolidated in the standalone `seagull-ui` repository. It is not the supported product UI and must not be deployed as the frontend for current PKG/Harness installations.

In particular, legacy actions that navigate to `/chat` are intentionally not maintained here. Agent Chat, Workflow execution, Session ownership, Agent Memory, and the unified Review Inbox belong to `seagull-ui` through the BFF and DeepSeek Harness.

Do not add new product features or repair feature drift in this directory. Apply active UI changes in the sibling `seagull-ui` repository instead.
