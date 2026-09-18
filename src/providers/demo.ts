import { recordProviderCall } from '../analytics.js';
import type { Signal } from '../types.js';
import type { IntelligenceProvider, NewsQuery, ReasonOptions } from './types.js';

/**
 * Local fallback provider (spec 17.1). Development only - the recorded showcase
 * runs ChainGPT live. Responses are deliberately labelled so demo output can
 * never be mistaken for live intelligence in the UI.
 */
export class DemoProvider implements IntelligenceProvider {
  readonly name = 'demo';

  async fetchNews(query: NewsQuery, label = 'demo.news'): Promise<Signal[]> {
    await recordProviderCall({ provider: this.name, kind: 'news', label, ok: true, latencyMs: 0, estimatedCredits: 0 });
    const now = Date.now();
    return DEMO_SIGNALS.map((s, i) => ({
      ...s,
      id: `demo_sig_${i}`,
      publishedAt: new Date(now - i * 5 * 3_600_000).toISOString(),
    })).slice(0, query.limit ?? 12);
  }

  async reason(prompt: string, options?: ReasonOptions): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 550));
    await recordProviderCall({
      provider: this.name, kind: 'chat', label: options?.label ?? 'demo.chat', ok: true, latencyMs: 550,
      chatHistory: options?.chatHistory === 'on', estimatedCredits: 0,
    });

    const task = /TASK_ID:\s*(\w+)/.exec(prompt)?.[1] ?? 'opportunity_radar';
    // The prompt builder only emits this block when saved knowledge exists, so its
    // presence is a faithful stand-in for "memory reached the model".
    const hasMemory = /RECENT SAVED KNOWLEDGE \(KULT canonical memory\)/.test(prompt)
      && !/\(none yet\)/.test(prompt.split('RECENT SAVED KNOWLEDGE')[1]?.slice(0, 200) ?? '');
    const knowledgeId = /KNOWLEDGE_ID:\s*(\S+)/.exec(prompt)?.[1] ?? '';
    // Ids the prompt actually offered - the demo cites only these, like a compliant model.
    const ids = (label: string) => [...prompt.matchAll(new RegExp(`${label}:\\s*(\\S+)`, 'g'))].map((m) => m[1]!);
    const cues: DemoCues = {
      evidenceIds: ids('EVIDENCE_ID'),
      outcomeIds: ids('OUTCOME_ID'),
      previousIds: ids('PREVIOUS_ID'),
    };

    if (task === 'decision_review') return { data: { bot: JSON.stringify(demoDecisionReview(prompt)) } };
    if (task === 'deep_research') return { data: { bot: JSON.stringify(demoResearch(cues.evidenceIds)) } };
    if (task === 'creator_growth') return { data: { bot: JSON.stringify(demoGrowth()) } };
    return { data: { bot: JSON.stringify(demoOpportunities(hasMemory, knowledgeId, cues)) } };
  }

  async health() {
    return { ok: true, detail: 'demo provider always available' };
  }
}

const DEMO_SIGNALS: Omit<Signal, 'id' | 'publishedAt'>[] = [
  {
    title: 'Immutable opens a new grants track for AI-native game studios',
    description:
      'The programme targets studios shipping agent-driven or procedurally generated gameplay, with distribution support attached to the grant rather than funding alone.',
    source: 'ChainGPT AI News (demo)',
    category: 'Gaming',
  },
  {
    title: 'Agent payment rails see rising adoption across consumer apps',
    description:
      'Several consumer platforms shipped agent-initiated micropayments this month, pushing agent commerce from prototype into live retail flows.',
    source: 'ChainGPT AI News (demo)',
    category: 'Agents',
  },
  {
    title: 'Creator distribution funds expand toward playable Web3 experiences',
    description:
      'Ecosystem funds increasingly prioritise creators who bring their own audience, shifting selection criteria from build quality alone to demonstrated retention.',
    source: 'ChainGPT AI News (demo)',
    category: 'Creator Economy',
  },
];

interface DemoCues {
  evidenceIds: string[];
  outcomeIds: string[];
  previousIds: string[];
}

/** Decision fields only exist when the prompt listed previous recommendations. */
function demoDecision(cues: DemoCues, index: number) {
  if (cues.previousIds.length === 0) return undefined;
  if (index === 0 && cues.previousIds[0]) {
    return {
      status: 'changed',
      previousId: cues.previousIds[0],
      reason: cues.outcomeIds.length
        ? 'The recorded outcome on the last recommendation changes the approach: follow up on the named programme instead of scanning broadly again.'
        : 'Saved research narrowed the previous recommendation to one named programme.',
    };
  }
  if (index === 1 && cues.previousIds[1]) {
    return { status: 'kept', previousId: cues.previousIds[1], reason: 'No new evidence contradicts it; it is still the strongest fit for agent commerce.' };
  }
  return { status: 'new', previousId: '', reason: 'New this scan - not part of the previous recommendation set.' };
}

function demoOpportunities(hasMemory: boolean, knowledgeId: string, cues: DemoCues) {
  const cite = (i: number) => (cues.evidenceIds[i] ? [cues.evidenceIds[i]!] : []);
  return {
    dropped: cues.previousIds[2]
      ? [{ previousId: cues.previousIds[2], reason: 'Superseded by the grant follow-up, which uses the same retention evidence.' }]
      : [],
    opportunities: [
      {
        title: 'Apply to the Immutable AI-native games grant track',
        relevance: 92,
        signal: 'Immutable opened a grants track aimed specifically at AI-driven game studios.',
        why: 'This Agent already ships agent-driven experiences through KULT Create and needs distribution more than capital.',
        opportunity: 'The track bundles distribution support with funding, which matches the Agent’s stated growth goal.',
        action: 'Draft a one-page submission leading with retention numbers from the published experience.',
        memoryInfluence: hasMemory
          ? {
              used: true,
              reason: 'Builds on prior saved research into AI gaming ecosystem programmes - the next step moves from scanning programmes to submitting to a named one.',
              knowledgeIds: knowledgeId ? [knowledgeId] : [],
            }
          : { used: false, reason: '', knowledgeIds: [] },
        liveEvidence: { used: true, summary: 'Programme announcement is current and applications are open.', evidenceTypes: ['news'] },
        evidenceIds: cite(0),
        outcomeIds: cues.outcomeIds.slice(0, 1),
        decision: demoDecision(cues, 0),
      },
      {
        title: 'Position the Agent for agent-commerce pilot partnerships',
        relevance: 78,
        signal: 'Agent-initiated payments moved into live consumer flows this month.',
        why: 'The Agent has Agent Commerce activity on KULT, so it can credibly pilot rather than merely comment.',
        opportunity: 'Early pilot slots favour teams with a working agent surface already in production.',
        action: 'Shortlist three agent-payment infrastructure teams and request a pilot conversation.',
        memoryInfluence: { used: false, reason: '', knowledgeIds: [] },
        liveEvidence: { used: true, summary: 'Multiple live consumer deployments reported recently.', evidenceTypes: ['news', 'market'] },
        evidenceIds: cite(1),
        outcomeIds: [],
        decision: demoDecision(cues, 1),
      },
      {
        title: 'Target creator distribution funds with retention evidence',
        relevance: 71,
        signal: 'Creator funds are shifting selection criteria toward demonstrated retention.',
        why: 'The Agent’s published experience has real session data that most applicants cannot show.',
        opportunity: 'Retention evidence is now the differentiator, not production polish.',
        action: 'Package a one-page retention brief and send it to two ecosystem creator funds.',
        memoryInfluence: { used: false, reason: '', knowledgeIds: [] },
        liveEvidence: { used: false, summary: '', evidenceTypes: [] },
        evidenceIds: [],
        outcomeIds: [],
        decision: demoDecision(cues, 2),
      },
    ],
  };
}

/** Mirrors demoDecision: first item changes P1, second keeps P2, third is new, P3 is dropped. */
function demoDecisionReview(prompt: string) {
  const items = [...prompt.matchAll(/^- (N\d+):/gm)].map((m) => m[1]!);
  const prev = [...prompt.matchAll(/^- (P\d+):/gm)].map((m) => m[1]!);
  const outcome = /^- outcome (\S+):/m.exec(prompt)?.[1];
  return {
    decisions: items.map((item, i) => {
      if (i === 0 && prev[0]) {
        return {
          item, status: 'changed', previousId: prev[0],
          reason: outcome
            ? `Outcome ${outcome} (no response) changes the approach: follow up on the named programme instead of scanning broadly again.`
            : 'Saved research narrowed the previous recommendation to one named programme.',
        };
      }
      if (i === 1 && prev[1]) return { item, status: 'kept', previousId: prev[1], reason: 'No new evidence contradicts it; it is still the strongest fit for agent commerce.' };
      return { item, status: 'new', previousId: '', reason: 'New this scan - not part of the previous recommendation set.' };
    }),
    dropped: prev[2] ? [{ previousId: prev[2], reason: 'Superseded by the grant follow-up, which uses the same retention evidence.' }] : [],
  };
}

function demoResearch(evidenceIds: string[]) {
  return {
    summary:
      'The grant track funds AI-native game studios and attaches ecosystem distribution support, making it a distribution channel as much as a funding source.',
    whyNow: 'Applications are open now and early cohorts historically receive disproportionate ecosystem promotion.',
    fitForAgent:
      'This Agent already operates a published, agent-driven KULT Create experience with measurable sessions, which is exactly the profile the track selects for.',
    liveEvidence: {
      summary: 'Current announcement coverage confirms the track is open; no on-chain metrics are relevant to a grant application.',
      items: [
        {
          type: 'news', evidence: 'Grant track announcement is recent and applications are confirmed open.',
          sourceLabel: 'ChainGPT AI News (demo)', evidenceId: evidenceIds[0] ?? '',
        },
      ],
      confidenceNote: 'Demo provider output - not live ChainGPT evidence.',
    },
    recommendedActions: [
      'Draft a one-page submission led by retention and session data.',
      'Request an intro conversation with the ecosystem developer relations contact.',
      'Prepare a distribution ask that is specific rather than open-ended.',
    ],
    targets: ['Immutable ecosystem grants', 'AI gaming developer relations', 'Ecosystem creator funds'],
    growthAngle: 'Position the experience as proof that agent-driven gameplay retains players, not as an experiment seeking funding.',
    risks: [
      'Eligibility may require a chain-specific deployment - verify before drafting.',
      'Grant timelines can run long; do not treat it as a near-term distribution plan.',
    ],
  };
}

function demoGrowth() {
  return {
    opportunities: [
      {
        title: 'AI gaming ecosystem grant and distribution programmes',
        relevance: 90,
        why: 'The experience is agent-driven and already published, which matches what these programmes actively select for.',
        targets: ['Immutable grants', 'AI gaming ecosystem funds', 'Chain developer relations teams'],
        growthAngle: 'Lead with retention evidence rather than concept novelty.',
        action: 'Submit to the open AI-native games track this week.',
      },
      {
        title: 'Creator communities with an existing racing and arcade audience',
        relevance: 76,
        why: 'The project’s audience overlaps directly with established arcade-game communities.',
        targets: ['Web3 gaming Discords', 'Arcade and racing creator collectives'],
        growthAngle: 'Position as a fast session players can finish in one sitting.',
        action: 'Run one seeded community tournament with a leaderboard.',
      },
      {
        title: 'Agent-commerce pilots for in-experience rewards',
        relevance: 64,
        why: 'Agent payment rails are live and the experience has a natural reward loop.',
        targets: ['Agent payment infrastructure teams'],
        growthAngle: 'Frame the experience as a live testbed for agent-initiated rewards.',
        action: 'Request pilot access from one agent-payments team.',
      },
    ],
    campaignBrief: {
      positioning: 'A short-session, agent-driven arcade experience with retention data to prove it holds players.',
      firstAction: 'Publish the retention brief and attach it to the grant submission.',
    },
  };
}
