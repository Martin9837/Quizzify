import { Router } from 'express';
import { all, get, run, insert } from '../db/index.js';
import { id } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { validate, parsePagination } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requirePermission, ownerScopeClause } from '../middleware/auth.js';
import { indexRecord } from '../services/search/index.js';

const router = Router();

// GET /companies
router.get('/', requirePermission('company:read'), asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
  // The filters are built once and shared by the page query and the count, so
  // the two can never disagree about what is being counted.
  const params = [req.auth.organizationId];
  let where = 'c.organization_id = ?';
  if (req.query.q) {
    where += ' AND (c.name LIKE ? OR c.domain LIKE ?)';
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.industry) {
    where += ' AND c.industry = ?';
    params.push(req.query.industry);
  }

  // `total` alongside limit/offset, as every other collection endpoint
  // returns. Without it a client paging this endpoint cannot tell whether
  // there is another page, or render "showing N of M".
  const total = get(`SELECT COUNT(*) AS n FROM companies c WHERE ${where}`, params)?.n || 0;
  const companies = all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM leads l WHERE l.company_id = c.id AND l.archived_at IS NULL) AS contact_count,
       (SELECT COUNT(*) FROM deals d WHERE d.company_id = c.id AND d.stage NOT IN ('won','lost')) AS open_deals,
       (SELECT COALESCE(SUM(d.value), 0) FROM deals d WHERE d.company_id = c.id AND d.stage NOT IN ('won','lost')) AS pipeline_value
     FROM companies c WHERE ${where}
     ORDER BY pipeline_value DESC, c.name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ companies, total, limit, offset });
}));

// POST /companies
router.post('/', requirePermission('company:write'), asyncHandler(async (req, res) => {
  const data = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 200 },
    domain: { type: 'string', maxLength: 200 },
    industry: { type: 'string', maxLength: 100 },
    size: { type: 'string', maxLength: 40 },
    location: { type: 'string', maxLength: 160 },
    annualRevenue: { type: 'number', min: 0 },
    notes: { type: 'string', maxLength: 8000 },
  });
  const row = {
    id: id('cmp'),
    organization_id: req.auth.organizationId,
    name: data.name,
    domain: data.domain || null,
    industry: data.industry || null,
    size: data.size || null,
    location: data.location || null,
    annual_revenue: data.annualRevenue || null,
    notes: data.notes || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  insert('companies', row);
  indexRecord({
    organizationId: req.auth.organizationId, entityType: 'company', entityId: row.id,
    occurredAt: row.created_at, title: row.name,
    body: [row.domain, row.industry, row.location, row.notes].filter(Boolean).join(' '),
  });
  res.status(201).json({ company: row });
}));

// GET /companies/:id
router.get('/:companyId', requirePermission('company:read'), asyncHandler(async (req, res) => {
  const company = get('SELECT * FROM companies WHERE id = ? AND organization_id = ?', [req.params.companyId, req.auth.organizationId]);
  if (!company) throw notFound('Company');
  const scope = ownerScopeClause(req, 'l.owner_id', { includeUnassigned: true });
  res.json({
    company,
    contacts: all(
      `SELECT l.id, l.first_name, l.last_name, l.job_title, l.email, l.phone_e164, l.status, l.temperature, u.name AS owner_name
       FROM leads l LEFT JOIN users u ON u.id = l.owner_id
       WHERE l.company_id = ? AND l.archived_at IS NULL${scope.sql} ORDER BY l.score DESC`,
      [company.id, ...scope.params],
    ),
    deals: all(
      `SELECT d.*, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.company_id = ? ORDER BY d.value DESC`,
      [company.id],
    ),
    activity: all(
      `SELECT a.* FROM activities a WHERE a.company_id = ? OR a.lead_id IN
        (SELECT id FROM leads WHERE company_id = ?) ORDER BY a.occurred_at DESC LIMIT 40`,
      [company.id, company.id],
    ),
  });
}));

// PATCH /companies/:id
router.patch('/:companyId', requirePermission('company:write'), asyncHandler(async (req, res) => {
  const company = get('SELECT * FROM companies WHERE id = ? AND organization_id = ?', [req.params.companyId, req.auth.organizationId]);
  if (!company) throw notFound('Company');
  const patch = validate(req.body, {
    name: { type: 'string', maxLength: 200 },
    domain: { type: 'string', maxLength: 200 },
    industry: { type: 'string', maxLength: 100 },
    size: { type: 'string', maxLength: 40 },
    location: { type: 'string', maxLength: 160 },
    annualRevenue: { type: 'number', min: 0 },
    notes: { type: 'string', maxLength: 8000 },
  }, { partial: true });
  const columns = {
    name: patch.name, domain: patch.domain, industry: patch.industry, size: patch.size,
    location: patch.location, annual_revenue: patch.annualRevenue, notes: patch.notes,
  };
  const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (keys.length) {
    run(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => columns[k]), nowIso(), company.id]);
  }
  res.json({ company: get('SELECT * FROM companies WHERE id = ?', [company.id]) });
}));

export default router;
