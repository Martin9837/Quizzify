import { Router } from 'express';
import { all, get, parseJson, inList } from '../db/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { visibleUserIds } from '../middleware/auth.js';
import * as searchService from '../services/search/index.js';
import { boundedInt } from '../lib/validate.js';

const router = Router();

function scopeOf(req) {
  const ids = visibleUserIds(req);
  if (ids === 'all') return { type: 'org' };
  if (ids.length === 1) return { type: 'own', userId: ids[0] };
  return { type: 'team', userIds: ids };
}

/**
 * Attach the human-readable context a search hit needs to be clickable:
 * which lead it belongs to and what to show as a subtitle.
 */
function enrich(organizationId, results) {
  const leadIds = [...new Set(results.map((r) => r.leadId).filter(Boolean))];
  const leads = leadIds.length
    ? all(
      `SELECT id, first_name, last_name, company_name FROM leads
       WHERE organization_id = ? AND ${inList('id', leadIds).sql}`,
      [organizationId, ...inList('id', leadIds).params],
    )
    : [];
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  return results.map((result) => {
    const lead = result.leadId ? leadMap.get(result.leadId) : null;
    return {
      ...result,
      lead: lead ? { id: lead.id, name: `${lead.first_name} ${lead.last_name || ''}`.trim(), company: lead.company_name } : null,
      href: hrefFor(result),
    };
  });
}

function hrefFor(result) {
  switch (result.entityType) {
    case 'lead': return `/leads/${result.entityId}`;
    case 'deal': return `/pipeline?deal=${result.entityId}`;
    case 'call': return `/conversations/${result.entityId}`;
    case 'transcript': return result.leadId ? `/leads/${result.leadId}?tab=conversations` : '/conversations';
    case 'email': return result.leadId ? `/leads/${result.leadId}?tab=emails` : '/inbox';
    case 'task': return '/tasks';
    case 'meeting': return '/calendar';
    case 'note': return result.leadId ? `/leads/${result.leadId}` : '/';
    case 'company': return `/companies/${result.entityId}`;
    default: return '/';
  }
}

// GET /search?q=...  -- global search
router.get('/', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  // The same keys the answered path returns. Omitting `total` here meant a
  // client rendering `${total} results` printed "undefined results" the moment
  // the box was cleared.
  if (!query) return res.json({ query, results: [], grouped: {}, total: 0 });
  const entityTypes = req.query.types ? String(req.query.types).split(',') : undefined;

  const results = searchService.search({
    organizationId: req.auth.organizationId,
    query,
    entityTypes,
    scope: scopeOf(req),
    limit: boundedInt(req.query.limit, 40, { max: 200 }),
  });
  const enriched = enrich(req.auth.organizationId, results);

  const grouped = enriched.reduce((acc, result) => {
    acc[result.entityType] = acc[result.entityType] || [];
    acc[result.entityType].push(result);
    return acc;
  }, {});

  return res.json({ query, results: enriched, grouped, total: enriched.length });
}));

// POST /search/natural  -- "hot leads I spoke with last week who mentioned pricing"
router.post('/natural', asyncHandler(async (req, res) => {
  const query = String(req.body?.query || '').trim();
  // Same shape as the answered path below, down to the key names: this used to
  // return `filters` where the real response returns `interpretation`, so
  // reading interpretation.searchTerms threw a TypeError on a blank query.
  if (!query) {
    return res.json({
      query,
      interpretation: {
        entityTypes: [], temperature: null, status: null, stage: null,
        since: null, topics: [], scopedToMe: false, searchTerms: '',
      },
      results: [],
      total: 0,
    });
  }

  const { filters, results } = searchService.naturalSearch({
    organizationId: req.auth.organizationId,
    query,
    scope: scopeOf(req),
    userId: req.auth.userId,
    limit: boundedInt(req.body?.limit, 40, { max: 200 }),
  });

  // Post-filter on structured attributes the FTS index does not carry.
  let filtered = results;
  if (filters.temperature || filters.status) {
    const leadIds = [...new Set(results.map((r) => r.leadId).filter(Boolean))];
    if (leadIds.length) {
      const scoped = inList('id', leadIds);
      const params = [req.auth.organizationId, ...scoped.params];
      let sql = `SELECT id FROM leads WHERE organization_id = ? AND ${scoped.sql}`;
      if (filters.temperature) {
        sql += ' AND temperature = ?';
        params.push(filters.temperature);
      }
      if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
      }
      const allowed = new Set(all(sql, params).map((r) => r.id));
      filtered = results.filter((r) => !r.leadId || allowed.has(r.leadId));
    }
  }

  return res.json({
    query,
    interpretation: {
      entityTypes: filters.entityTypes,
      temperature: filters.temperature,
      status: filters.status,
      stage: filters.stage,
      since: filters.since,
      topics: filters.topics,
      scopedToMe: Boolean(filters.ownerId),
      searchTerms: filters.terms,
    },
    results: enrich(req.auth.organizationId, filtered),
    total: filtered.length,
  });
}));

// GET /search/suggest?q=  -- typeahead for the command palette
router.get('/suggest', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ suggestions: [] });
  const scope = scopeOf(req);
  const results = searchService.search({
    organizationId: req.auth.organizationId,
    query,
    entityTypes: ['lead', 'company', 'deal'],
    scope,
    limit: 8,
  });
  return res.json({
    suggestions: enrich(req.auth.organizationId, results).map((r) => ({
      type: r.entityType,
      label: r.title,
      sublabel: r.lead?.company || r.excerpt,
      href: r.href,
      entityId: r.entityId,
    })),
  });
}));

export default router;
