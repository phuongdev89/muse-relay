**English** | [Tiếng Việt](setup-guide.vi.md)

# Muse Relay Documentation

Welcome to the Muse Relay documentation suite. Use the index below to find the guide that matches your role.

| Document | Language | Audience & Purpose |
|---|---|---|
| [Setup, Deployment & Operations Guide](setup-guide.md) | English | **Operators & developers** setting up a fresh local or production instance: prerequisites, `.env` variables, Supabase Auth & migrations, Edge Function deployment, dashboard workflows, acceptance tests, and troubleshooting. |
| [Hướng dẫn Cài đặt, Triển khai & Vận hành](setup-guide.vi.md) | Tiếng Việt | **Người vận hành & lập trình viên** (bản tiếng Việt đầy đủ): yêu cầu hệ thống, cấu hình `.env`, thiết lập Supabase (Auth, 10 migrations, 2 secrets, 3 Edge Functions), chạy dev/production, sử dụng Dashboard, chạy suite test 53 assertions và xử lý sự cố. |
| [Architecture & Security Reference](architecture.md) | English | **Engineers & security reviewers**: Express `server/` routes and middleware, React `dashboard/` module layout, Postgres schema & RLS across all 10 migrations, Edge Functions & Muse `claim_message`/`submit_result` contract, `relay_muses` telemetry, and the 4 invariant principles. |
| [Supabase Relay Technical Spec](../supabase/README.md) | Tiếng Việt | **Backend & Muse integrators**: chi tiết 10 migration SQL, 3 Edge Functions (`submit_message`, `claim_message`, `submit_result`), contract claim/result phía Muse, cơ chế group fan-out, và quy trình vận hành/thu hồi token. |
| [Client Submission Example](examples/submit-example.ts) | TypeScript | **Integrators**: minimal TypeScript example demonstrating Supabase Auth sign-in, `relay-inputs` reference upload, and `submit_message` invocation for `chat`, `image`, and `video`. |

## Quick Links

- [Project Overview (English)](../README.md)
- [Tổng quan dự án (Tiếng Việt)](../README.vi.md)
- [Environment Template](../.env.example)
- [Root Package Scripts](../package.json)
