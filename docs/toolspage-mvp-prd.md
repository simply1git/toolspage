# Toolspage MVP PRD

## Product Goal
Build a fast, privacy-first web utility hub for everyday file tasks with minimal friction.

## Target Users
- Students handling assignment/document conversions.
- Job seekers and office users managing PDF and image files.
- Small businesses and freelancers preparing shareable assets and QR codes.

## Core Value Proposition
- One task, one clear page, one fast output.
- No signup needed for basic usage.
- Transparent file handling and deletion policy.

## MVP Scope (v1)

### In Scope (Tier 1)
1. PDF to Word
2. PDF to JPG
3. Word to PDF
4. JPG to PDF
5. Merge PDF
6. Compress PDF (preset targets + custom slider)
7. Compress Image (JPG/PNG/WebP)
8. Resize Image
9. Remove Background (Image)
10. QR Generator (URL, Text, Wi-Fi, vCard)
11. OCR (Image/PDF to text) - basic

### Out of Scope (v1)
- Team collaboration and shared workspaces.
- Dynamic QR analytics dashboard.
- API access.
- Video transcoding/compression.
- Risky media-downloader workflows that may violate platform policy.

## User Stories
- As a user, I can upload a file and get the transformed output in under a minute for normal sizes.
- As a user, I can use core tools without creating an account.
- As a user, I can trust that my file is deleted automatically after processing.
- As a user, I can use the tools comfortably on mobile and desktop.

## Functional Requirements

### Universal Processing Flow
1. User selects a tool page.
2. User uploads one or more files.
3. System validates type and size.
4. User chooses options (if any).
5. Job is processed.
6. User downloads result.
7. User sees clear delete-retention message.

### Shared Tool Requirements
- Drag/drop upload + file picker fallback.
- Format and size validation before upload.
- Progress indicator for processing.
- Clear success, retry, and error states.
- Related tool suggestions after completion.

### Tool-Specific Requirements
- `Compress PDF`: presets (100KB, 200KB, 500KB) and quality mode.
- `QR Generator`: support URL/Text/Wi-Fi/vCard with PNG download.
- `OCR`: extract text to downloadable TXT.

## Non-Functional Requirements
- Mobile-first responsive design.
- Accessibility: keyboard navigation, visible focus states, semantic labels.
- Performance goals (75th percentile):
  - LCP <= 2.5s
  - INP <= 200ms
  - CLS <= 0.1
- Security:
  - TLS in transit.
  - Temporary storage only.
  - Auto-delete policy visible on each tool page.

## Analytics Events
- `tool_page_view`
- `upload_started`
- `upload_validation_failed`
- `processing_started`
- `processing_succeeded`
- `processing_failed`
- `download_clicked`
- `retention_notice_viewed`

## KPI Targets (First 90 Days)
- Tool completion rate >= 65%
- Median time-to-download < 25s for typical jobs
- Repeat weekly usage >= 20%
- Bounce rate on tool pages < 45%

## Release Plan
- Milestone 1: Landing page + routing + 3 tools (PDF to Word, Compress PDF, QR Generator)
- Milestone 2: Full Tier 1 set with consistent UX
- Milestone 3: Premium hooks (limits, ad-free mode), if needed

## Open Questions
- Final file size limits by tool and tier.
- Which OCR engine to use in v1.
- Whether remove-background should be model-based server side or external provider.
