import { parseJson } from '../db/index.js';

/**
 * Row-to-response mappers, shared by every endpoint that returns these
 * entities.
 *
 * They used to live as local consts in their own route modules, which meant
 * the lead-detail endpoint -- the busiest screen in the app -- returned bare
 * database rows for the same records: snake_case columns, `organization_id`
 * the client has no use for, `pinned` as 1 rather than true, and
 * `meetings[].attendees` as a JSON *string* instead of an array. A client
 * could not share render code between the detail screen and the collections.
 */

export const noteView = (row) => ({
  id: row.id,
  leadId: row.lead_id,
  dealId: row.deal_id,
  callId: row.call_id,
  authorId: row.author_id,
  authorName: row.author_name,
  body: row.body,
  pinned: Boolean(row.pinned),
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const taskView = (row) => ({
  id: row.id,
  leadId: row.lead_id,
  dealId: row.deal_id,
  callId: row.call_id,
  assigneeId: row.assignee_id,
  assigneeName: row.assignee_name,
  createdBy: row.created_by,
  title: row.title,
  description: row.description,
  type: row.type,
  priority: row.priority,
  status: row.status,
  dueAt: row.due_at,
  completedAt: row.completed_at,
  source: row.source,
  aiReason: row.ai_reason,
  contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
  companyName: row.company_name,
  createdAt: row.created_at,
  overdue: row.status === 'open' && row.due_at && new Date(row.due_at) < new Date(),
});

export const meetingView = (row) => ({
  id: row.id,
  leadId: row.lead_id,
  dealId: row.deal_id,
  organizerId: row.organizer_id,
  organizerName: row.organizer_name,
  title: row.title,
  description: row.description,
  type: row.type,
  location: row.location,
  conferenceUrl: row.conference_url,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  timezone: row.timezone,
  attendees: parseJson(row.attendees, []),
  status: row.status,
  reminderMinutes: row.reminder_minutes,
  inviteSentAt: row.invite_sent_at,
  externalCalendar: row.external_calendar,
  aiSuggested: Boolean(row.ai_suggested),
  outcomeNotes: row.outcome_notes,
  contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : null,
  companyName: row.company_name,
});

/**
 * `body` is deliberately absent from the lead-detail email list, which selects
 * a summary subset of columns -- undefined keys drop out of the JSON rather
 * than arriving as null.
 */
export const emailView = (row) => ({
  id: row.id,
  leadId: row.lead_id,
  dealId: row.deal_id,
  callId: row.call_id,
  userId: row.user_id,
  direction: row.direction,
  template: row.template,
  to: row.to_address,
  cc: parseJson(row.cc, []),
  subject: row.subject,
  body: row.body,
  bodyFormat: row.body_format,
  status: row.status,
  generatedByAi: Boolean(row.generated_by_ai),
  editedByHuman: Boolean(row.edited_by_human),
  provider: row.provider,
  sentAt: row.sent_at,
  openedAt: row.opened_at,
  repliedAt: row.replied_at,
  error: row.error,
  createdAt: row.created_at,
  contactName: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : undefined,
  companyName: row.company_name,
  senderName: row.sender_name,
});

export default { noteView, taskView, meetingView, emailView };
