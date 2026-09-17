/* @ds-bundle: {"format":4,"namespace":"Portikus","components":[{"name":"NameMark"},{"name":"Icon"},{"name":"Button"},{"name":"IconButton"},{"name":"Menu"},{"name":"Dialog"},{"name":"ConfirmDialog"},{"name":"Tabs"},{"name":"Toast"},{"name":"StateBadge"},{"name":"Table"},{"name":"TextField"},{"name":"Select"},{"name":"Checkbox"},{"name":"Skeleton"},{"name":"EmptyState"},{"name":"ShortcutHint"},{"name":"PaneHandle"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var F = React.Fragment;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }
  function omit(o, keys) { var r = {}; for (var k in o) if (keys.indexOf(k) < 0) r[k] = o[k]; return r; }

  /* ---------- Icon ---------- */
  var PATHS = {
    terminal: ['R3 4 18 16 1.5', 'M7 9l3 3-3 3', 'M12.5 15H17'],
    agent: ['M12 3v5', 'M12 16v5', 'M3 12h5', 'M16 12h5', 'M5.6 5.6l3.2 3.2', 'M15.2 15.2l3.2 3.2', 'M5.6 18.4l3.2-3.2', 'M15.2 8.8l3.2-3.2'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
    folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
    'folder-open': ['M3 17.5v-11A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10', 'M3 17.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4l-2.6 6.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 17.5z'],
    preview: ['R3 4 18 16 1.5', 'M3 9h18', 'M6.5 6.5h.01', 'M9 6.5h.01'],
    plus: ['M12 5v14', 'M5 12h14'],
    x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
    'chevron-right': ['M9.5 6l6 6-6 6'],
    'chevron-down': ['M6 9.5l6 6 6-6'],
    'chevron-up': ['M6 14.5l6-6 6 6'],
    'chevron-up-down': ['M8 9.5l4-4 4 4', 'M8 14.5l4 4 4-4'],
    external: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    alert: ['M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z', 'M12 9.5v4', 'M12 17h.01'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    info: ['C12 12 9', 'M12 11v5', 'M12 8h.01'],
    search: ['C11 11 6.5', 'M20 20l-4.4-4.4'],
    play: ['M8 5.5v13l10.5-6.5z'],
    stop: ['R6.5 6.5 11 11 1'],
    restart: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4 9.5', 'M4 4.5v5h5'],
    lock: ['R5 11 14 10 1.5', 'M8 11V8a4 4 0 0 1 8 0v3'],
    grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
    storage: ['E12 6 8 3', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
    trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7'],
    'sign-out': ['M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4', 'M10 16l4-4-4-4', 'M14 12H4']
  };
  var DOTS = { more: 1, grip: 1, preview: 0 };
  function Icon(props) {
    var name = props.name, size = props.size || 'md';
    var parts = (PATHS[name] || PATHS.info).map(function (d, i) {
      var t = d.charAt(0), a;
      if (t === 'R') { a = d.slice(1).split(' ').map(Number); return h('rect', { key: i, x: a[0], y: a[1], width: a[2], height: a[3], rx: a[4] }); }
      if (t === 'C') { a = d.slice(1).split(' ').map(Number); return h('circle', { key: i, cx: a[0], cy: a[1], r: a[2] }); }
      if (t === 'E') { a = d.slice(1).split(' ').map(Number); return h('ellipse', { key: i, cx: a[0], cy: a[1], rx: a[2], ry: a[3] }); }
      return h('path', { key: i, d: d, strokeWidth: /h\.01$/.test(d) ? (DOTS[name] ? 2.6 : 2.2) : undefined });
    });
    return h('svg', { className: cx('pk-icon', size !== 'md' && 'pk-icon--' + size, props.className), viewBox: '0 0 24 24', 'aria-hidden': props.label ? undefined : true, role: props.label ? 'img' : undefined, 'aria-label': props.label }, parts);
  }

  /* ---------- NameMark ---------- */
  // Full mark: a portico on a 96 x 48 grid (lintel, two columns with capital and base, a base line) framing a terminal.
  // Compact mark: the same idea on a 32 x 32 grid, without capitals, for 16 to 24 px (favicon, collapsed rail).
  var MARK = {
    full: { box: '0 0 96 48', stone: 'M0 0h96v6h-96z M2 7L17 7L16 11L3 11z M4 11h11v26h-11z M3 37L16 37L17 41L2 41z M79 7L94 7L93 11L80 11z M81 11h11v26h-11z M80 37L93 37L94 41L79 41z M0 42h96v6h-96z', room: 'M20 11h56v28h-56z', code: 'M25 16h39v2.5h-39z M25 21h22v2.5h-22z M25 26h30v2.5h-30z', cursor: 'M25 31h3v5.5h-3z' },
    compact: { box: '0 0 32 32', stone: 'M1 4h30v3H1z M3 8h4v16H3z M25 8h4v16h-4z M1 25h30v3H1z', room: 'M9 8h14v16H9z', code: 'M11 11h8v2h-8z M11 15h5v2h-5z', cursor: 'M11 19h2v3h-2z' }
  };
  function NameMark(props) {
    var size = props.size || 20;
    var variant = props.variant || (props.markOnly && size < 24 ? 'compact' : 'full');
    var g = MARK[variant];
    var mark = h('svg', { viewBox: g.box, className: 'pk-mark pk-mark--' + variant, 'aria-hidden': true },
      h('path', { className: 'pk-mark-stone', d: g.stone }),
      h('path', { className: 'pk-mark-room', d: g.room }),
      h('path', { className: 'pk-mark-code', d: g.code }),
      h('path', { className: 'pk-mark-cursor', d: g.cursor }));
    var Tag = props.href ? 'a' : 'span';
    return h(Tag, { className: cx('pk-namemark', props.href && 'pk-link', props.className), href: props.href, style: { fontSize: size + 'px' }, 'aria-label': props.markOnly ? 'Portikus' : undefined },
      mark, props.markOnly ? null : h('span', null, 'Portikus'));
  }

  /* ---------- Button ---------- */
  function Button(props) {
    var variant = props.variant || 'secondary', size = props.size || 'md';
    var rest = omit(props, ['variant', 'size', 'loading', 'iconStart', 'iconEnd', 'className', 'children']);
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('pk-btn', 'pk-btn--' + variant, size !== 'md' && 'pk-btn--' + size, props.className),
      'aria-busy': props.loading ? true : undefined,
      'aria-disabled': props.loading ? true : rest['aria-disabled']
    }),
      props.loading ? h('span', { className: 'pk-spin', 'aria-hidden': true }) : (props.iconStart ? h(Icon, { name: props.iconStart }) : null),
      props.children,
      props.iconEnd ? h(Icon, { name: props.iconEnd }) : null);
  }

  /* ---------- ShortcutHint ---------- */
  var KEYMAP = { mac: { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Enter: '↵' }, other: { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', Enter: 'Enter' } };
  function ShortcutHint(props) {
    var platform = props.platform || 'other';
    var map = KEYMAP[platform] || KEYMAP.other;
    var spoken = props.keys.join(' ');
    return h('span', { className: cx('pk-shortcut', props.plain && 'pk-shortcut--plain', props.className), 'aria-label': 'Shortcut: ' + spoken.replace(/Mod/g, platform === 'mac' ? 'Command' : 'Control') },
      props.keys.map(function (k, i) { return h('kbd', { key: i, className: 'pk-kbd', 'aria-hidden': true }, map[k] || k); }));
  }

  /* ---------- IconButton ---------- */
  function IconButton(props) {
    var rest = omit(props, ['icon', 'label', 'shortcut', 'variant', 'size', 'tooltipOpen', 'className']);
    var btn = h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('pk-iconbtn', props.variant === 'secondary' && 'pk-iconbtn--secondary', props.size === 'sm' && 'pk-iconbtn--sm', props.className),
      'aria-label': props.label
    }), h(Icon, { name: props.icon, size: props.size === 'sm' ? 'sm' : 'md' }));
    if (!props.tooltipOpen) return btn;
    return h('span', { style: { position: 'relative', display: 'inline-block' } }, btn,
      h('span', { role: 'tooltip', className: 'pk-tooltip', style: { position: 'absolute', top: '100%', left: '50%', transform: 'translate(-50%, 6px)' } },
        props.label, props.shortcut ? h(ShortcutHint, { keys: props.shortcut, plain: true }) : null));
  }

  /* ---------- Menu ---------- */
  function Menu(props) {
    return h('div', { role: 'menu', 'aria-label': props.label, className: cx('pk-menu', props.className), style: props.style, 'data-state': 'open' }, props.children);
  }
  function MenuItem(props) {
    return h('div', {
      role: 'menuitem', tabIndex: -1,
      className: cx('pk-menu-item', props.danger && 'pk-menu-item--danger'),
      'data-highlighted': props.highlighted ? '' : undefined,
      'data-disabled': props.disabled ? '' : undefined,
      'aria-disabled': props.disabled || undefined,
      onClick: props.disabled ? undefined : props.onSelect
    },
      props.icon ? h(Icon, { name: props.icon }) : null,
      h('span', { className: 'pk-menu-item-label' }, props.children),
      props.shortcut ? h(ShortcutHint, { keys: props.shortcut, plain: true }) : null);
  }
  function MenuSeparator() { return h('div', { role: 'separator', className: 'pk-menu-sep' }); }
  function MenuLabel(props) { return h('div', { className: 'pk-menu-label' }, props.children); }
  Menu.Item = MenuItem; Menu.Separator = MenuSeparator; Menu.Label = MenuLabel;

  /* ---------- Dialog ---------- */
  function Dialog(props) {
    var inline = props.inline;
    return h(F, null,
      h('div', { className: cx('pk-scrim', inline && 'pk-scrim--inline'), 'data-state': 'open' }),
      h('div', { role: props.role || 'dialog', 'aria-modal': true, 'aria-labelledby': props.id ? props.id + '-t' : undefined, 'aria-describedby': props.description && props.id ? props.id + '-d' : undefined, className: cx('pk-dialog', inline && 'pk-dialog--inline', props.size === 'lg' && 'pk-dialog--lg'), 'data-state': 'open' },
        h('div', { className: 'pk-dialog-head' },
          props.statusIcon ? h('div', { className: 'pk-dialog-status' }, h(Icon, { name: props.statusIcon, size: 'lg' })) : null,
          h('div', null,
            h('h2', { id: props.id ? props.id + '-t' : undefined, className: 'pk-dialog-title' }, props.title),
            props.description ? h('p', { id: props.id ? props.id + '-d' : undefined, className: 'pk-dialog-desc' }, props.description) : null),
          props.hideClose ? null : h(IconButton, { icon: 'x', label: 'Close', className: 'pk-dialog-close', size: 'sm', onClick: props.onClose })),
        props.children ? h('div', { className: 'pk-dialog-body' }, props.children) : null,
        props.footer ? h('div', { className: 'pk-dialog-foot' }, props.footer) : null));
  }

  function ConfirmDialog(props) {
    var confirmText = props.confirmText;
    var st = React.useState(props.typedValue || '');
    var typed = st[0], setTyped = st[1];
    var ready = !confirmText || typed === confirmText;
    return h(Dialog, {
      id: props.id || 'pk-confirm', role: 'alertdialog', inline: props.inline, title: props.title, description: props.description,
      statusIcon: 'alert', hideClose: true,
      footer: h(F, null,
        h(Button, { variant: 'secondary', onClick: props.onCancel, autoFocus: true }, props.cancelLabel || 'Cancel'),
        h(Button, { variant: 'danger', disabled: !ready, onClick: props.onConfirm, loading: props.pending }, props.confirmLabel))
    },
      (props.survives || props.lost) ? h('div', { className: 'pk-consequence' },
        h('div', { className: 'pk-lost' }, h('h3', null, 'Will be removed'), h('ul', null, (props.lost || []).map(function (x, i) { return h('li', { key: i }, x); }))),
        h('div', null, h('h3', null, 'Will be kept'), h('ul', null, (props.survives || []).map(function (x, i) { return h('li', { key: i }, x); })))) : null,
      confirmText ? h('div', { style: { marginTop: 'var(--space-4)' } },
        h(TextField, { id: (props.id || 'pk-confirm') + '-typed', label: h(F, null, 'Type ', h('span', { className: 'pk-mono' }, confirmText), ' to confirm'), mono: true, value: typed, onChange: function (e) { setTyped(e.target.value); }, autoComplete: 'off', spellCheck: false })) : null);
  }

  /* ---------- Tabs ---------- */
  var KIND_ICON = { terminal: 'terminal', claude: 'agent', codex: 'agent', file: 'file', preview: 'preview', panel: 'info' };
  function Tabs(props) {
    return h('div', { className: cx('pk-tabs', props.className) },
      h('div', { role: 'tablist', 'aria-label': props.label || 'Open tabs', 'aria-orientation': 'horizontal', className: 'pk-tablist' },
        props.tabs.map(function (t) {
          var active = t.id === props.activeId;
          return h('div', {
            key: t.id, role: 'tab', tabIndex: active ? 0 : -1, 'aria-selected': active, 'data-state': active ? 'active' : 'inactive',
            title: t.title || t.label,
            className: cx('pk-tab', 'pk-focus-inset', t.kind === 'terminal' && !t.ended && 'pk-tab--terminal', t.ended && 'pk-tab--ended', t.id === props.draggingId && 'pk-tab--dragging', t.id === props.dropBeforeId && 'pk-tab--drop-before'),
            onClick: function () { props.onSelect && props.onSelect(t.id); },
            onKeyDown: function (e) { if (e.key === 'Delete' && t.closable !== false && props.onClose) props.onClose(t.id); }
          },
            h(Icon, { name: KIND_ICON[t.kind] || 'file', size: 'sm' }),
            h('span', { className: 'pk-tab-label' }, t.label, t.ended ? h('span', { className: 'pk-visually-hidden' }, ', session ended') : null),
            t.closable === false ? null : (t.dirty
              ? h('span', { className: 'pk-tab-close', role: 'img', 'aria-label': 'Unsaved changes' }, h('span', { className: 'pk-tab-dirty' }))
              : h('span', { className: cx('pk-tab-close', !t.pinnedClose && 'pk-tab-close--hover'), role: 'button', 'aria-label': 'Close ' + t.label, tabIndex: -1, onClick: function (e) { e.stopPropagation(); props.onClose && props.onClose(t.id); } }, h(Icon, { name: 'x', size: 'sm' }))));
        })),
      h('div', { className: 'pk-tabs-actions' },
        props.actions || h(IconButton, { icon: 'plus', label: 'New tab', size: 'sm', 'aria-haspopup': 'menu', 'aria-expanded': !!props.launcherOpen, shortcut: ['Mod', 'Alt', 'T'] })));
  }

  /* ---------- Toast ---------- */
  var TONE_ICON = { neutral: 'info', success: 'check', warning: 'alert', danger: 'alert' };
  function Toast(props) {
    var tone = props.tone || 'neutral';
    return h('div', { role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status', className: cx('pk-toast', 'pk-toast--' + tone, props.className), 'data-state': 'open' },
      h(Icon, { name: TONE_ICON[tone], className: 'pk-toast-icon' }),
      h('div', { className: 'pk-toast-main' },
        h('p', { className: 'pk-toast-title' }, props.title),
        props.children ? h('p', { className: 'pk-toast-body' }, props.children) : null,
        props.actions ? h('div', { className: 'pk-toast-actions' }, props.actions) : null),
      h(IconButton, { icon: 'x', label: 'Dismiss', size: 'sm', className: 'pk-toast-close', onClick: props.onDismiss }));
  }

  /* ---------- StateBadge ---------- */
  var STATE_LABEL = { provisioning: 'Setting up', starting: 'Starting', running: 'Running', stopping: 'Stopping', stopped: 'Stopped', error: 'Error', restarting: 'Restarting' };
  function resolveWorkspaceState(state, desired) {
    // Returns { tone, label, moving }. A difference between desired and actual is a transition, never an error.
    if (state === 'error') return { tone: 'error', label: STATE_LABEL.error, moving: false };
    if (state === 'provisioning' || state === 'starting' || state === 'stopping') return { tone: state, label: desired === 'restarting' ? STATE_LABEL.restarting : STATE_LABEL[state], moving: true };
    if (desired === 'restarting') return { tone: 'starting', label: STATE_LABEL.restarting, moving: true };
    if (state === 'running' && desired === 'stopped') return { tone: 'stopping', label: STATE_LABEL.stopping, moving: true };
    if (state === 'stopped' && desired === 'running') return { tone: 'starting', label: STATE_LABEL.starting, moving: true };
    return { tone: state, label: STATE_LABEL[state] || state, moving: false };
  }
  function StateBadge(props) {
    var r = resolveWorkspaceState(props.state, props.desiredState || props.state);
    var glyph = r.moving ? h('span', { className: 'pk-spin', 'aria-hidden': true })
      : r.tone === 'error' ? h(Icon, { name: 'alert', size: 'sm' })
      : r.tone === 'stopped' ? h('span', { className: 'pk-badge-ring', 'aria-hidden': true })
      : h('span', { className: 'pk-badge-dot', 'aria-hidden': true });
    return h('span', { className: cx('pk-badge', 'pk-badge--' + r.tone, props.plain && 'pk-badge--plain', props.className), role: 'status', 'aria-live': props.live ? 'polite' : undefined, 'data-state': props.state, 'data-desired-state': props.desiredState },
      glyph, props.label || r.label);
  }
  StateBadge.resolve = resolveWorkspaceState;

  /* ---------- Table ---------- */
  function Table(props) {
    var key = props.rowKey || 'id';
    return h('div', { className: 'pk-table-wrap', style: props.style },
      h('table', { className: 'pk-table', 'aria-label': props.label },
        h('thead', null, h('tr', null, props.columns.map(function (c) {
          var inner = c.sortable
            ? h('button', { type: 'button', className: 'pk-table-sort', 'aria-sort': c.sort ? (c.sort === 'asc' ? 'ascending' : 'descending') : undefined }, c.header, h(Icon, { name: c.sort === 'asc' ? 'chevron-up' : c.sort === 'desc' ? 'chevron-down' : 'chevron-up-down', size: 'sm' }))
            : c.header;
          return h('th', { key: c.key, scope: 'col', className: cx(c.align === 'right' && 'pk-num', c.key === 'actions' && 'pk-cell-actions'), style: { width: c.width }, 'aria-sort': c.sort ? (c.sort === 'asc' ? 'ascending' : 'descending') : undefined }, c.key === 'actions' ? h('span', { className: 'pk-visually-hidden' }, c.header) : inner);
        }))),
        h('tbody', null, props.rows.map(function (r) {
          return h('tr', { key: r[key], 'aria-selected': r[key] === props.selectedKey ? true : undefined },
            props.columns.map(function (c) {
              return h('td', { key: c.key, className: cx(c.align === 'right' && 'pk-num', c.mono && 'pk-mono', c.muted && 'pk-cell-muted', c.key === 'actions' && 'pk-cell-actions') }, c.render ? c.render(r) : r[c.key]);
            }));
        }))));
  }

  /* ---------- Form fields ---------- */
  function TextField(props) {
    var id = props.id || 'pk-field';
    var rest = omit(props, ['label', 'hint', 'error', 'mono', 'id', 'className']);
    var describedBy = [props.hint && id + '-hint', props.error && id + '-err'].filter(Boolean).join(' ') || undefined;
    return h('div', { className: cx('pk-field', props.className) },
      h('label', { className: 'pk-label', htmlFor: id }, props.label),
      h('input', Object.assign({ type: 'text' }, rest, { id: id, className: cx('pk-input', props.mono && 'pk-mono'), 'aria-invalid': props.error ? true : undefined, 'aria-describedby': describedBy })),
      props.error ? h('p', { className: 'pk-error', id: id + '-err' }, h(Icon, { name: 'alert', size: 'sm' }), props.error) : null,
      props.hint ? h('p', { className: 'pk-hint', id: id + '-hint' }, props.hint) : null);
  }
  function Select(props) {
    var id = props.id || 'pk-select';
    var current = (props.options || []).filter(function (o) { return o.value === props.value; })[0];
    return h('div', { className: cx('pk-field', props.className) },
      h('label', { className: 'pk-label', id: id + '-l', htmlFor: id }, props.label),
      h('button', { type: 'button', id: id, role: 'combobox', 'aria-expanded': !!props.open, 'aria-labelledby': id + '-l ' + id, className: 'pk-select', 'data-placeholder': current ? undefined : '' },
        h('span', { style: current ? null : { color: 'var(--ink-faint)' } }, current ? current.label : (props.placeholder || 'Choose…')),
        h(Icon, { name: 'chevron-up-down' })),
      props.hint ? h('p', { className: 'pk-hint' }, props.hint) : null);
  }
  function Checkbox(props) {
    return h('label', { className: cx('pk-check', props.className) },
      h('input', { type: 'checkbox', checked: !!props.checked, disabled: props.disabled, onChange: props.onChange || function () {} }),
      h('span', { className: 'pk-check-box', 'aria-hidden': true }, props.checked ? h(Icon, { name: 'check', size: 'sm' }) : null),
      h('span', { className: 'pk-check-text' },
        h('span', null, props.label),
        props.description ? h('span', { className: 'pk-hint' }, props.description) : null));
  }

  /* ---------- Skeleton ---------- */
  function Skeleton(props) {
    var v = props.variant || 'text';
    if (v === 'text' && props.lines > 1) {
      var arr = [];
      for (var i = 0; i < props.lines; i++) arr.push(h('span', { key: i, className: 'pk-skel pk-skel--text', style: { width: i === props.lines - 1 ? '60%' : '100%' } }));
      return h('span', { className: 'pk-skel-stack', 'aria-hidden': true, style: { width: props.width } }, arr);
    }
    return h('span', { className: cx('pk-skel', 'pk-skel--' + v, props.className), 'aria-hidden': true, style: { width: props.width, height: props.height } });
  }

  /* ---------- EmptyState ---------- */
  function EmptyState(props) {
    return h('div', { className: cx('pk-empty', props.className) },
      props.icon ? h('div', { className: 'pk-empty-icon' }, h(Icon, { name: props.icon, size: 'lg' })) : null,
      h('h3', { className: 'pk-empty-title' }, props.title),
      props.children ? h('p', { className: 'pk-empty-body' }, props.children) : null,
      props.actions ? h('div', { className: 'pk-empty-actions' }, props.actions) : null);
  }

  /* ---------- PaneHandle ---------- */
  function PaneHandle(props) {
    var o = props.orientation || 'vertical';
    return h('div', {
      role: 'separator', tabIndex: 0, 'aria-orientation': o, 'aria-label': props.label || 'Resize pane',
      'aria-valuenow': props.value, 'aria-valuemin': props.min, 'aria-valuemax': props.max,
      'aria-controls': props.controls,
      'data-resize-handle-state': props.state || 'inactive',
      className: cx('pk-handle', props.className), style: props.style
    }, h('span', { className: 'pk-handle-grip' }));
  }

  var api = { NameMark: NameMark, Icon: Icon, Button: Button, IconButton: IconButton, Menu: Menu, MenuItem: MenuItem, MenuSeparator: MenuSeparator, MenuLabel: MenuLabel, Dialog: Dialog, ConfirmDialog: ConfirmDialog, Tabs: Tabs, Toast: Toast, StateBadge: StateBadge, resolveWorkspaceState: resolveWorkspaceState, Table: Table, TextField: TextField, Select: Select, Checkbox: Checkbox, Skeleton: Skeleton, EmptyState: EmptyState, ShortcutHint: ShortcutHint, PaneHandle: PaneHandle };
  window.Portikus = Object.assign(window.Portikus || {}, api);
})();
