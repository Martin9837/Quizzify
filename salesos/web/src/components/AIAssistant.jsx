import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { Drawer, Spinner, Badge } from './UI.jsx';
import { renderMarkdown } from '../lib/format.js';
import { IconSparkles, IconRobot } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';

/**
 * The persistent AI assistant.
 *
 * Available from every screen. Answers come from the server's tool-calling
 * assistant, which only ever queries records this user is permitted to see, so
 * the panel needs no permission logic of its own.
 */

const AGENT_PROMPTS = [
  'Who should I call today?',
  'Which of my deals are at risk?',
  'Show leads I have not contacted in 14 days',
  'Which leads are most likely to convert?',
  'What objections come up most often?',
  'What does my pipeline forecast look like?',
];

const MANAGER_PROMPTS = [
  'How is the team performing this month?',
  'Which deals are at risk across the team?',
  'What objections come up most often?',
  'Why are we losing deals?',
  'Which agents need coaching?',
  'What is the weighted forecast?',
];

export default function AIAssistant({ open, onClose, initialQuestion, contextLabel }) {
  const { user, isManager } = useAuth();
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [provider, setProvider] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  const ask = useCallback(async (text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed || pending) return;
    setMessages((current) => [...current, { role: 'user', content: trimmed }]);
    setQuestion('');
    setPending(true);
    try {
      const result = await api.post('/ai/ask', { question: trimmed, conversationId });
      setConversationId(result.conversationId);
      setProvider(result.provider);
      setMessages((current) => [...current, {
        role: 'assistant',
        content: result.answer,
        tools: result.toolsUsed,
        latencyMs: result.latencyMs,
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        role: 'assistant',
        content: error.message || 'I could not answer that. Please try again.',
        failed: true,
      }]);
    } finally {
      setPending(false);
    }
  }, [conversationId, pending]);

  useEffect(() => {
    if (open && initialQuestion) ask(initialQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuestion]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending]);

  const prompts = isManager ? MANAGER_PROMPTS : AGENT_PROMPTS;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="AI sales assistant"
      actions={provider && <Badge tone={provider.startsWith('anthropic') ? 'accent' : 'outline'}>{provider === 'local' ? 'built-in engine' : provider}</Badge>}
      footer={(
        <form
          className="row-tight"
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
        >
          <input
            ref={inputRef}
            className="input grow"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={contextLabel ? `Ask about ${contextLabel}` : 'Ask about your pipeline'}
            aria-label="Ask the AI assistant"
            disabled={pending}
          />
          <button type="submit" className="btn primary" disabled={pending || !question.trim()}>
            {pending ? <Spinner /> : <IconSparkles />}
            Ask
          </button>
        </form>
      )}
    >
      {messages.length === 0 && (
        <div className="col">
          <div className="row-tight">
            <span style={{ color: 'var(--accent)' }}><IconRobot size={20} /></span>
            <div className="col-tight" style={{ gap: 2 }}>
              <strong>Ask anything about your CRM</strong>
              <span className="small muted">
                {user?.name?.split(' ')[0]}, I can only see the records you are permitted to see.
              </span>
            </div>
          </div>
          <div className="assistant-suggestions">
            {prompts.map((prompt) => (
              <button key={prompt} type="button" className="assistant-chip" onClick={() => ask(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="assistant-messages">
        {messages.map((message, index) => (
          <div key={index} className={`assistant-msg ${message.role}`}>
            {message.role === 'assistant' ? (
              <>
                {/* Server output is plain text/markdown produced by our own
                    renderer; no user HTML is ever interpolated here. */}
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                {message.tools?.length > 0 && (
                  <div className="row-tight xs muted mt-2 wrap">
                    {message.tools.map((tool) => <Badge key={tool} tone="outline">{tool.replace(/_/g, ' ')}</Badge>)}
                    {message.latencyMs !== undefined && <span>{message.latencyMs} ms</span>}
                  </div>
                )}
              </>
            ) : (
              message.content
            )}
          </div>
        ))}
        {pending && (
          <div className="assistant-msg assistant row-tight">
            <Spinner /> <span className="muted small">Looking through your pipeline…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {messages.length > 0 && (
        <div className="assistant-suggestions">
          {prompts.slice(0, 3).map((prompt) => (
            <button key={prompt} type="button" className="assistant-chip" onClick={() => ask(prompt)}>{prompt}</button>
          ))}
        </div>
      )}
    </Drawer>
  );
}
