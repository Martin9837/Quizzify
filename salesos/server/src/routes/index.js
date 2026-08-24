import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import config from '../config.js';
import { PIPELINE_STAGES, LEAD_STATUSES, LEAD_TEMPERATURES, LEAD_SOURCES, TASK_TYPES,
  TASK_PRIORITIES, CALL_OUTCOMES, EMAIL_TEMPLATES, OBJECTION_CATEGORIES,
  COACHING_DIMENSIONS, ACTIVITY_TYPES, WEBHOOK_EVENTS } from '../lib/constants.js';
import { ROLES, ROLE_LABELS } from '../lib/permissions.js';
import { SUPPORTED_COUNTRIES } from '../lib/phone.js';

import authRoutes from './auth.js';
import leadRoutes from './leads.js';
import companyRoutes from './companies.js';
import dealRoutes from './deals.js';
import callRoutes from './calls.js';
import conversationRoutes from './conversations.js';
import aiRoutes from './ai.js';
import emailRoutes from './emails.js';
import messageRoutes from './messages.js';
import taskRoutes from './tasks.js';
import noteRoutes from './notes.js';
import meetingRoutes from './meetings.js';
import notificationRoutes from './notifications.js';
import activityRoutes from './activities.js';
import searchRoutes from './search.js';
import analyticsRoutes from './analytics.js';
import coachingRoutes from './coaching.js';
import adminRoutes from './admin.js';
import webhookInRoutes from './webhooksIn.js';
import eventRoutes from './events.js';

const router = Router();

// Provider callbacks authenticate by signature, so they sit before `authenticate`.
router.use('/webhooks', webhookInRoutes);

// Reference data the UI needs before a user signs in.
router.get('/meta', (req, res) => {
  res.json({
    product: { name: 'SalesOS', version: '1.0.0', environment: config.env },
    pipelineStages: PIPELINE_STAGES,
    leadStatuses: LEAD_STATUSES,
    leadTemperatures: LEAD_TEMPERATURES,
    leadSources: LEAD_SOURCES,
    taskTypes: TASK_TYPES,
    taskPriorities: TASK_PRIORITIES,
    callOutcomes: CALL_OUTCOMES,
    emailTemplates: EMAIL_TEMPLATES,
    objectionCategories: OBJECTION_CATEGORIES,
    coachingDimensions: COACHING_DIMENSIONS,
    activityTypes: ACTIVITY_TYPES,
    webhookEvents: WEBHOOK_EVENTS,
    roles: ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role] })),
    supportedCountries: SUPPORTED_COUNTRIES,
    telephonyProvider: config.telephony.provider,
    emailProvider: config.email.provider,
  });
});

router.use('/auth', authRoutes);

// Everything below requires an authenticated identity.
router.use(authenticate, rateLimit());

router.use('/events', eventRoutes);
router.use('/leads', leadRoutes);
router.use('/companies', companyRoutes);
router.use('/deals', dealRoutes);
router.use('/calls', callRoutes);
router.use('/conversations', conversationRoutes);
router.use('/ai', aiRoutes);
router.use('/emails', emailRoutes);
router.use('/messages', messageRoutes);
router.use('/tasks', taskRoutes);
router.use('/notes', noteRoutes);
router.use('/meetings', meetingRoutes);
router.use('/notifications', notificationRoutes);
router.use('/activities', activityRoutes);
router.use('/search', searchRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/coaching', coachingRoutes);
router.use('/admin', adminRoutes);

export default router;
