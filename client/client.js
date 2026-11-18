/* dsh-discuss session form: a collapsible subscription panel above the composer. */
window.__ModuleLoader__.load({
  id: '@local/dsh-discuss',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Dock card above the composer, sized like the composer card the shell
    // already lays out. The slot renders straight into the composer stack,
    // which spans the whole column, so the wrapper reproduces the input card's
    // own box (side clearance as inline padding). The card inside then resolves
    // --dsh-composer-card-max-width against the same containing block the input
    // card uses, so the two are exactly as wide in the docked, hero and
    // embedded occurrences alike.
    // The browser sees the Host's `agent-preset/selected` event, so a switch to
    // discuss can refresh the panel immediately instead of waiting out the
    // refresh interval. One subscription serves every mounted panel.
    const presetListeners = new Set()

    const S = {
      wrapper: {
        boxSizing: 'border-box',
        flex: 'none',
        width: '100%',
        padding: '0 var(--dsh-composer-side-clearance, 16px)',
      },
      root: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: 'var(--dsh-composer-card-max-width, 952px)',
        margin: '0 auto',
        // Hairline stroke rides the elevation shadow, so no layout border; the
        // rebinding below re-substitutes --dsw-elevation-panel on this element.
        border: 0,
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-lg, 16px)',
        background: 'var(--dsw-specific-menu, rgba(127,127,127,0.06))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
        boxShadow: 'var(--dsw-elevation-panel, 0 0 0 0.5px rgba(127,127,127,0.25))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        // Deliberately no overflow clipping: the header's 2px focus ring paints
        // outside its box and must stay visible. Nothing inside paints past the
        // rounded edge.
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 12px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      },
      title: { fontWeight: 500, fontSize: 13 },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' },
      spacer: { flex: 1 },
      dot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary, #3aa55a)', display: 'inline-block' },
      dotOff: { width: 7, height: 7, borderRadius: '50%', background: 'rgba(127,127,127,0.6)', display: 'inline-block' },
      body: {
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        padding: '4px 12px 10px',
        maxHeight: 220,
        overflowY: 'auto',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' },
      name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // Unsubscribed topics stay listed but recede, so the switch state reads
      // at a glance without another text column.
      nameDim: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      id: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      badge: {
        padding: '0 6px',
        borderRadius: 999,
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: 11,
        lineHeight: '16px',
      },
      // Host switch geometry (ui-primitives Switch): 36×20 capsule, 16px thumb
      // with 16px of travel. Inline styles cannot key off aria-checked, so the
      // component computes these from the same `checked` value the attribute
      // carries.
      switchTrack: {
        boxSizing: 'border-box',
        flex: '0 0 auto',
        width: 36,
        height: 20,
        padding: 2,
        border: 0,
        borderRadius: 999,
        transition: 'background-color 120ms ease',
      },
      switchThumb: {
        display: 'block',
        width: 16,
        height: 16,
        borderRadius: '50%',
        transition: 'transform 120ms ease',
      },
      // Inline confirm for the destructive direction only (unsubscribing drops
      // unacked queued mail on the server).
      confirmButton: {
        padding: '2px 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      stopButton: {
        padding: '2px 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-state-error-primary, #c0392b)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #c0392b)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      error: { padding: '4px 12px 8px', color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
      empty: { padding: '6px 0', color: 'var(--dsw-alias-label-tertiary, inherit)' },
    }

    function CountBadge(props) {
      const counts = props.counts
      if (!counts) return null
      const total = (counts.injected || 0) + (counts.pending || 0)
      if (total === 0) return null
      return h('span', {
        style: S.badge,
        title: counts.injected + ' injected and unprocessed, ' + counts.pending + ' waiting to be injected',
      }, String(total))
    }

    /**
     * Two-state toggle: the row affordance is the switch itself, so a click
     * asks for the opposite state and the row applies it right away.
     */
    function SwitchToggle(props) {
      const checked = props.checked
      const busy = props.busy === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        // aria-disabled rather than disabled: a focused button that flips to
        // disabled is blurred, and keyboard users would lose their place on
        // every toggle. The guarded click is what actually refuses the input.
        'aria-disabled': busy ? true : undefined,
        'aria-label': props.label,
        title: props.title,
        onClick: function () {
          if (busy) return
          props.onChange(!checked)
        },
        style: {
          ...S.switchTrack,
          background: checked
            ? 'var(--dsw-alias-brand-primary, #2f6fde)'
            : 'var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
          opacity: busy ? 0.5 : 1,
          cursor: busy ? 'default' : 'pointer',
        },
      }, h('span', {
        style: {
          ...S.switchThumb,
          background: checked
            ? 'var(--dsw-alias-label-primary-foreground, #fff)'
            : 'var(--dsw-alias-switch-thumb, #fff)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
        },
      }))
    }

    function TopicRow(props) {
      const topic = props.topic
      const confirming = props.confirming
      return h('div', { style: S.row },
        h('span', { style: topic.subscribed ? S.name : S.nameDim, title: topic.name }, topic.name),
        h('span', { style: S.id }, topic.id),
        h(CountBadge, { counts: props.counts }),
        confirming
          ? h(React.Fragment, null,
            h('span', { style: S.muted }, 'Stop receiving?'),
            h('button', {
              style: S.stopButton,
              'aria-disabled': props.busy ? true : undefined,
              onClick: function () { if (!props.busy) props.onStop(topic.id) },
            }, 'Stop'),
            h('button', {
              style: S.confirmButton,
              'aria-disabled': props.busy ? true : undefined,
              onClick: function () { props.onKeep() },
            }, 'Keep'))
          : h(SwitchToggle, {
            checked: topic.subscribed === true,
            busy: props.busy,
            // The setting, not the action: the switch role announces
            // "paused/unpaused" from aria-checked, so the name stays neutral.
            label: topic.name + ' subscription',
            title: topic.subscribed
              ? 'On — turn off to stop receiving this topic'
              : 'Off — turn on to receive this topic',
            onChange: function (next) { props.onToggle(topic.id, next) },
          }))
    }

    function SubscribeForm(props) {
      const sessionId = props.sessionId
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [hidden, setHidden] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [confirming, setConfirming] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [pending, setPending] = React.useState(false)
      const refreshRef = React.useRef(10000)
      // The host answers `pending` while a discuss-preset session has no board
      // client yet (preset switch still mounting). Polling that state fast is
      // what makes the panel appear with the client instead of up to one slow
      // refresh interval later.
      const pendingRef = React.useRef(false)
      // A 404 means "no board client", which is also the state during the first
      // moments of a preset switch. Retry that briefly at the fast cadence, then
      // settle back so a session that genuinely has no client costs one request
      // per interval.
      const readyRef = React.useRef(false)
      // An error here usually means the board server itself is down; the panel
      // keeps retrying quickly so it heals on its own when the board returns.
      const errorRef = React.useRef(false)
      const fastTriesRef = React.useRef(0)

      const loadSeq = React.useRef(0)
      const load = React.useCallback(async () => {
        // Only the newest request owns the state: the 10s poll may resolve after
        // the reload that follows a write, and would otherwise snap a finished
        // toggle back to its pre-write position for a cycle.
        const seq = ++loadSeq.current
        try {
          const response = await fetch('/discuss/api/state?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          const body = await response.json().catch(() => ({}))
          if (seq !== loadSeq.current) return
          if (response.status === 404) {
            // Standard and discuss-admin sessions have no board client. Drop
            // the rendered rows too: `hidden` is only consulted while state is
            // null, so a stale state would keep the panel on screen after the
            // session switched away from discuss.
            setHidden(true)
            setState(null)
            setOpen(false)
            setConfirming(null)
            setPending(false)
            pendingRef.current = false
            errorRef.current = false
            readyRef.current = false
            setError(null)
            return
          }
          if (!response.ok) throw new Error((body.error && body.error.message) || ('HTTP ' + response.status))
          if (body.pending === true) {
            setPending(true)
            setHidden(false)
            pendingRef.current = true
            errorRef.current = false
            setError(null)
            return
          }
          pendingRef.current = false
          setPending(false)
          setState(body)
          errorRef.current = false
          readyRef.current = true
          fastTriesRef.current = 0
          setError(null)
          if (typeof body.refreshSeconds === 'number' && body.refreshSeconds > 0) {
            refreshRef.current = body.refreshSeconds * 1000
          }
        } catch (cause) {
          if (seq !== loadSeq.current) return
          errorRef.current = true
          setError(String((cause && cause.message) || cause))
        }
      }, [sessionId])

      // A preset switch is the one event that can add a board client to this
      // session, so refresh on it instead of waiting for the next tick.
      React.useEffect(() => {
        let probe = null
        const listener = function (changedSessionId) {
          if (changedSessionId !== sessionId) return
          void load()
          // The Host's attach/detach can land a moment after the forwarded
          // event; one delayed probe settles both directions instead of leaving
          // the panel stale until the next scheduled tick.
          if (probe !== null) clearTimeout(probe)
          probe = setTimeout(function () {
            probe = null
            void load()
          }, 500)
        }
        presetListeners.add(listener)
        return function () {
          presetListeners.delete(listener)
          if (probe !== null) clearTimeout(probe)
        }
      }, [sessionId, load])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          await load()
          if (!alive) return
          // A second of retry covers the attach window; after that the panel
          // falls back to the server's refresh interval so a session whose
          // client never arrives costs one request per interval, not per second.
          let fast = false
          if (pendingRef.current || errorRef.current) {
            // Waiting for the client to attach, or for the board to come back:
            // keep the fast cadence for a bounded stretch.
            fast = fastTriesRef.current < 30
            fastTriesRef.current += 1
          } else if (!readyRef.current && fastTriesRef.current < 20) {
            // 404 right after mount or right after a preset switch.
            fast = true
            fastTriesRef.current += 1
          }
          timer = setTimeout(tick, fast ? 1000 : refreshRef.current)
        }
        void tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [load])

      async function apply(topicId, subscribed) {
        setBusy(true)
        try {
          const response = await fetch('/discuss/api/subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, topicId: topicId, subscribed: subscribed }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error((body.error && body.error.message) || ('HTTP ' + response.status))
          setConfirming(null)
          await load()
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Turning a topic ON applies immediately; turning it OFF only arms the
       * inline confirm, because the server drops that topic's unacked mail and
       * re-subscribing cannot bring it back.
       */
      function toggle(topicId, next) {
        if (next) {
          void apply(topicId, true)
          return
        }
        setConfirming(topicId)
      }

      if (state === null) {
        if (hidden) return null
        return h('div', { style: S.wrapper },
          h('div', { style: S.root },
            h('div', { style: S.header },
              h('span', { style: S.title }, 'Discussions'),
              h('span', { style: S.muted, title: error ?? undefined },
                error === null
                  ? (pending ? 'connecting…' : 'loading…')
                  : 'unavailable — ' + error.slice(0, 60)))))
      }

      const topics = Array.isArray(state.topics) ? state.topics : []
      const counts = state.backlog || {}
      const subscribed = topics.filter(function (topic) { return topic.subscribed })
      const summary = subscribed.length === 0
        ? 'no subscriptions'
        : subscribed.length + ' subscribed'

      return h('div', { style: S.wrapper },
        h('div', { style: S.root },
          h('button', {
            style: S.header,
            onClick: function () { setOpen(!open) },
            title: 'Control which discussion topics this session subscribes to',
            'aria-expanded': open,
          },
            h('span', { style: S.dot }),
            h('span', { style: S.title }, 'Discussions'),
            h('span', { style: S.muted }, state.username ? '@' + state.username : 'unregistered'),
            h('span', { style: S.spacer }),
            h('span', { style: S.muted }, summary),
            h('span', { style: S.muted, 'aria-hidden': true }, open ? '▾' : '▸')),
          error !== null ? h('div', { style: S.error }, error) : null,
          open
            ? h('div', { style: S.body },
              topics.length === 0
                ? h('div', { style: S.empty }, 'No topics exist yet. Ask the admin agent to create one.')
                : topics.map(function (topic) {
                  return h(TopicRow, {
                    key: topic.id,
                    topic: topic,
                    counts: counts[topic.id],
                    confirming: confirming === topic.id,
                    busy: busy,
                    onToggle: toggle,
                    onStop: function (id) { void apply(id, false) },
                    onKeep: function () { setConfirming(null) },
                  })
                }))
            : null))
    }

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        ctx.effect(function () {
          const off = ctx.remote.$on('agent-preset/selected', function (sessionId) {
            for (const listener of presetListeners) listener(sessionId)
          })
          return function () {
            presetListeners.clear()
            if (typeof off === 'function') off()
          }
        }, 'dsh-discuss: preset events')

        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-discuss',
            order: 10,
          }, SubscribeForm)
        })
      },
    }
  },
})
