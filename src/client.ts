(window as any).__ModuleLoader__.load({
  id: 'dsh-skill-gate',
  factory: (require: (id: string) => any) => {
    /**
     * dsh-skill-gate 的浏览器半边：侧边栏「插件」页里本插件那张卡上的配置区。
     *
     * 这里编辑 `requiredSkills` —— 会话开始自动加载的 skill 名单。候选来自宿主半边的只读路由
     * `GET /dsh-skill-gate/skill-index`（浏览器拿不到 catalog，只能由宿主交出来），画成复选列表
     * 加一个过滤框；配置里有、但当前 catalog 里没有的名字单独一组保留下来。
     *
     * 勾选状态不是本组件的局部状态：它**就是**配置字段的草稿文本（一行一个名字）。点一下复选框
     * = `props.edit(FIELD, 新文本)`，保存与丢弃仍由官方 `SettingsFormModel` / `SettingsForm`
     * 承担 —— 本卡片不自己写回 Host。
     *
     * 路由拿不到数据（老版本宿主 / 非 web profile / 服务缺失）时退回「一行一个名字」的文本框，
     * 并在界面上说明为什么退化；绝不白屏。
     *
     * 手写 `__ModuleLoader__.load` 包装是浏览器半边的加载协议：客户端插件以「一个自带 id 的
     * 工厂」注册，`require` 由加载器注入。全文件不使用 JSX —— `React.createElement` 的第三个
     * 参数起是 children，而自动 jsx runtime 从 `props.children` 读取，混用会静默渲染出空元素。
     */
    var module = { exports: {} as any }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 官方表单原语：暂存、保存、丢弃、不可用提示都由它们承担，不自己发明。 */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const SettingsForm = primitives.SettingsForm
    const SettingsFormModel = primitives.SettingsFormModel

    /**
     * 本插件在 profile 里的**条目 id**（patch 里的 `id`），也就是配置表单的命名空间。
     * 与宿主半边 `cordis.patch.yml` 的 id 逐字一致。
     */
    const NS = 'skill-gate'
    /** 本卡片编辑的唯一字段；名字必须与宿主半边 schema 逐字一致（已持久化的值不能改名）。 */
    const FIELD = 'requiredSkills'
    /** 组合包配置区的 key：必须是**包名**（= package.json 的 name）。 */
    const BUNDLE_KEY = 'dsh-skill-gate'
    /** 行配置区的 key：`<包名>#<patch 里声明的行 id>`。 */
    const ROW_KEY = 'dsh-skill-gate#skill-gate'
    /** 宿主半边注册的只读 catalog 路由。 */
    const SKILL_ROUTE = '/dsh-skill-gate/skill-index'

    const styles: Record<string, any> = {
      page: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0' },
      label: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
      hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
      failed: { color: 'var(--dsw-alias-label-error)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
      group: { display: 'flex', flexDirection: 'column', gap: '2px' },
      groupHead: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5, marginTop: '4px' },
      groupHeadWarn: { color: 'var(--dsw-alias-label-error)', fontSize: '12px', lineHeight: 1.5, marginTop: '4px' },
      filter: {
        font: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
        height: '30px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 10px',
        fontSize: '13px'
      },
      row: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '3px 0', cursor: 'pointer' },
      checkbox: { flex: 'none', marginTop: '2px' },
      col: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 },
      skillName: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)'
      },
      skillNameWarn: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-error)'
      },
      desc: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      textarea: {
        font: 'inherit',
        width: '100%',
        minHeight: '88px',
        boxSizing: 'border-box',
        resize: 'vertical',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '8px 10px',
        fontSize: '13px',
        lineHeight: 1.5
      },
      controls: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      badge: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.5 },
      reset: {
        appearance: 'none',
        cursor: 'pointer',
        border: 'none',
        background: 'none',
        padding: 0,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)'
      }
    }

    /**
     * 一行一个名字，也接受半角/全角逗号分隔；去首尾空白、去空项、去重。
     * 不做格式校验：宿主 schema 只要求字符串数组，catalog 里不存在的名字由自动加载的软化逻辑兜住
     * （忽略并出声，见宿主半边），在这里把保存卡死反而会让用户改不动配置。
     */
    function splitNames(text: string): string[] {
      const out: string[] = []
      const seen: Record<string, boolean> = {}
      const parts = String(text == null ? '' : text).split(/[\n,，]/)
      for (const part of parts) {
        const name = part.trim()
        if (name === '' || seen[name]) continue
        seen[name] = true
        out.push(name)
      }
      return out
    }

    /** 按 catalog 的顺序排列勾选结果，catalog 里没有的名字排在最后（相互保持原顺序）。 */
    function orderedNames(selected: string[], catalogOrder: string[]): string[] {
      const rank: Record<string, number> = {}
      catalogOrder.forEach((name, index) => { rank[name] = index })
      return selected.slice().sort((a, b) => {
        const ra = a in rank ? rank[a] : catalogOrder.length
        const rb = b in rank ? rank[b] : catalogOrder.length
        return ra - rb
      })
    }

    /**
     * 数组字段的转换 spec：存的是 `string[]`，草稿是「一行一个」的文本。
     * 空文本走 `clear`（清掉用户层、回到 schema 默认的 `[]`），正好等于「一个都不勾 = 不生效」。
     */
    const requiredSkillsField = {
      field: FIELD,
      format: (value: any) => (Array.isArray(value) ? value.join('\n') : ''),
      parse: (text: string) => {
        const names = splitNames(text)
        return names.length === 0 ? { kind: 'clear' } : { kind: 'set', value: names }
      }
    }

    /**
     * 依赖的客户端服务：槽位注册表 + 配置表单（`configForms`，由 dsh-client-ui-settings 提供）。
     * 服务名在这里 inject，不写进 `dsh.client.inject`（那一层是部署侧的声明）。
     */
    const inject = ['slots', 'configForms']

    /**
     * 挂载插件页的配置区。
     * @param ctx - 浏览器端插件上下文。
     */
    function apply(ctx: any) {
      // `configForms.get(entryId)` 用的 entryId 是本插件在 profile 里的条目 id，
      // 与宿主半边 Config 的命名空间同一个值。
      const scope = ctx.configForms.get(NS)
      const formModel = new SettingsFormModel(scope, [requiredSkillsField])
      ctx.effect(() => () => { formModel.dispose() })

      /** 表单投影：`shell` 是保存栏状态，字段本身是一份读数（text / overridden / invalid）。 */
      const formStore = formModel.bind(() => ({
        shell: formModel.shell(),
        [FIELD]: formModel.field(FIELD)
      }))
      ctx.effect(() => () => { formStore.dispose() })

      /** 官方 `SettingsForm` 的文案契约。 */
      const formLabels = {
        unavailable: '本部署没有提供这项配置。',
        readOnly: '本部署的配置为只读，无法在此修改。',
        save: '保存',
        saving: '保存中…',
        saveFailed: '保存失败，改动未生效。'
      }

      /**
       * 当前会话 id：**可选**服务 + 可选能力，拿不到就 null。
       * 拿不到时不要报错也不要传空串 —— 交给宿主自己按 roots/list/currentInitiator 挑 agent。
       */
      function currentSessionId(): string | null {
        try {
          const sessions = ctx.get('sessions')
          const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : null
          const id = snapshot ? snapshot.current : null
          return typeof id === 'string' && id.length > 0 ? id : null
        } catch (e) {
          return null
        }
      }

      /**
       * 卡片正文。
       *
       * 勾选态**派生**自字段草稿文本，不另存一份局部状态 —— 于是「用户点了复选框」与
       * 「官方表单的暂存值」天然是同一份东西，不会出现两处打架。
       */
      function SkillGateConfigEntry(props: any) {
        const state = props.useSkillGateForm((snapshot: any) => snapshot)
        const [catalog, setCatalog] = React.useState({
          status: 'loading',
          skills: [],
          error: null,
          partial: false,
          reason: null
        } as {
          status: 'loading' | 'ready' | 'error'
          skills: Array<{ name: string; description: string }>
          error: string | null
          partial: boolean
          reason: string | null
        })
        const [filter, setFilter] = React.useState('')
        const [notice, setNotice] = React.useState(null as string | null)
        // 只有「从脏变干净、且不是因为失败」才算一次落地的保存，避免首屏就显示「已保存」。
        const wasDirty = React.useRef(false)

        // catalog 只取一次：它是候选列表，与当前草稿无关。
        React.useEffect(() => {
          let live = true
          const load = async () => {
            try {
              // 带上当前会话 id，宿主就能拿它当 agent scope；拿不到就不带，宿主自己挑。
              const sessionId = currentSessionId()
              const url = sessionId === null
                ? SKILL_ROUTE
                : SKILL_ROUTE + '?session=' + encodeURIComponent(sessionId)
              const response = await fetch(url, { headers: { accept: 'application/json' } })
              const payload: any = await response.json().catch(() => null)
              if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
              if (!payload || !Array.isArray(payload.skills)) throw new Error('返回的形状不是 { skills: [...] }')
              if (!live) return
              const items = payload.skills
                .filter((item: any) => item && typeof item.name === 'string' && item.name !== '')
                .map((item: any) => ({
                  name: item.name,
                  description: typeof item.description === 'string' ? item.description : ''
                }))
                .sort((a: any, b: any) => a.name.localeCompare(b.name))
              setCatalog({
                status: 'ready',
                skills: items,
                error: null,
                partial: payload.partial === true,
                reason: typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : null
              })
            } catch (error) {
              if (!live) return
              // 读不到就退回文本框：说明为什么退化，绝不白屏。
              setCatalog({
                status: 'error',
                skills: [],
                error: (error && error.message) || '无法读取 skill 列表',
                partial: false,
                reason: null
              })
            }
          }
          void load()
          return () => { live = false }
        }, [])

        React.useEffect(() => {
          if (state.shell.dirty) {
            wasDirty.current = true
            return
          }
          if (wasDirty.current && !state.shell.saving && !state.shell.failed) {
            wasDirty.current = false
            setNotice('已保存。')
          }
        }, [state.shell.dirty, state.shell.saving, state.shell.failed])

        React.useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), 6000)
          return () => clearTimeout(timer)
        }, [notice])

        const field = state[FIELD]
        const locked = !state.shell.writable || state.shell.saving
        const selected = splitNames(field.text)
        const catalogOrder = catalog.skills.map((item: any) => item.name)
        const catalogNames: Record<string, boolean> = {}
        catalogOrder.forEach((name: string) => { catalogNames[name] = true })
        // 配置里有、catalog 里没有的名字：单独一组保留，默认勾选（它们本来就在名单里）。
        const configuredUnknown = selected.filter((name) => !catalogNames[name])

        /** 点一下复选框：改的是字段草稿文本，不碰路由数据。 */
        const toggle = (name: string) => {
          const next = selected.slice()
          const at = next.indexOf(name)
          if (at === -1) next.push(name)
          else next.splice(at, 1)
          props.edit(FIELD, orderedNames(next, catalogOrder).join('\n'))
        }

        const keyword = filter.trim().toLowerCase()
        const visible = keyword === ''
          ? catalog.skills
          : catalog.skills.filter((item: any) =>
              item.name.toLowerCase().indexOf(keyword) !== -1 ||
              item.description.toLowerCase().indexOf(keyword) !== -1)

        const selectionLine = selected.length === 0
          ? '当前一个都没勾：名单为空，不生效（这是刻意的：没配名单就不加载）。'
          : '已勾选 ' + selected.length + ' 份：' + selected.join('、')

        /** 降级路径：路由不可用时回到上一版的「一行一个名字」。 */
        const fallbackEditor = () => h(
          'div',
          { style: styles.page, key: 'fallback' },
          h('p', { style: styles.failed, role: 'status' },
            '无法读取 skill 列表（' + (catalog.error || '未知原因') + '），已退回手动输入。'),
          h('label', { style: styles.label, htmlFor: 'dsh-skill-gate-required' }, '必读 skill 名单'),
          h('p', { style: styles.hint }, '一行一个名字（也支持逗号分隔）。留空 = 没配名单，不生效。'),
          h('textarea', {
            id: 'dsh-skill-gate-required',
            style: styles.textarea,
            rows: 4,
            spellCheck: false,
            disabled: locked,
            placeholder: 'your-required-skill',
            value: field.text,
            onChange: (event: any) => { props.edit(FIELD, event.target.value) }
          })
        )

        /** 勾选列表：catalog 组 + 「已配置但不在 catalog」组。 */
        const checklist = () => h(
          'div',
          { style: styles.page, key: 'checklist' },
          h('label', { style: styles.label }, '必读 skill 名单'),
          h('p', { style: styles.hint }, '勾上会话开始自动加载的 skill。一个都不勾 = 名单为空 = 不生效。'),
          catalog.partial
            ? h('p', { style: styles.failed, role: 'status' },
                catalog.reason || '只列出全局层：当前没有可用的会话，项目级/用户级 skill 可能不在列表里。')
            : null,
          catalog.status === 'loading'
            ? h('p', { style: styles.hint, role: 'status' }, '正在读取 skill 列表…')
            : null,
          h('input', {
            type: 'text',
            style: styles.filter,
            placeholder: '过滤 skill 名或描述',
            value: filter,
            disabled: locked,
            onChange: (event: any) => { setFilter(event.target.value) }
          }),
          h(
            'div',
            { style: styles.group },
            h('div', { style: styles.groupHead }, '当前 catalog（' + catalog.skills.length + ' 份）'),
            catalog.status === 'ready' && catalog.skills.length === 0
              ? h('p', { style: styles.hint }, '当前 catalog 里一份 skill 都没有。')
              : null,
            catalog.status === 'ready' && catalog.skills.length > 0 && visible.length === 0
              ? h('p', { style: styles.hint }, '没有匹配「' + filter.trim() + '」的 skill。')
              : null,
            visible.map((item: any) => h(
              'label',
              { key: item.name, style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: selected.indexOf(item.name) !== -1,
                disabled: locked,
                onChange: () => { toggle(item.name) }
              }),
              h(
                'span',
                { style: styles.col },
                h('span', { style: styles.skillName }, item.name),
                item.description === ''
                  ? null
                  : h('span', { style: styles.desc, title: item.description }, item.description)
              )
            ))
          ),
          configuredUnknown.length === 0 ? null : h(
            'div',
            { style: styles.group },
            h('div', { style: styles.groupHeadWarn },
              '已配置但当前 catalog 里没有（' + configuredUnknown.length + ' 份）'),
            h('p', { style: styles.hint },
              '这些名字不在列表里：可能已改名 / 删除，或属于项目级 skill。默认保留；取消勾选即从名单里去掉。'),
            configuredUnknown.map((name) => h(
              'label',
              { key: name, style: styles.row },
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: true,
                disabled: locked,
                onChange: () => { toggle(name) }
              }),
              h('span', { style: styles.col }, h('span', { style: styles.skillNameWarn }, name))
            ))
          ),
          h('p', { style: styles.hint, role: 'status' }, selectionLine)
        )

        return h(
          SettingsForm,
          { labels: formLabels, state: state.shell, onSave: props.save, onDiscard: props.discard },
          catalog.status === 'error' ? fallbackEditor() : checklist(),
          field.overridden
            ? h(
                'div',
                { style: styles.controls },
                h('span', { style: styles.badge }, '已覆盖'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.reset,
                    disabled: locked,
                    onClick: () => { props.resetField(FIELD) }
                  },
                  '恢复默认'
                )
              )
            : null,
          state.shell.failed
            ? h('p', { style: styles.failed, role: 'status' }, '保存失败，改动未生效。')
            : null,
          notice !== null ? h('p', { style: styles.hint, role: 'status' }, notice) : null
        )
      }

      /**
       * 配置区挂两处：
       *   - `plugins.bundle.config`，key = 包名 —— 组合包自己的页面（用户停的那一页）；
       *   - `plugins.row.config`，key = `<包名>#<行 id>` —— 包内那一行的行内配置。
       * 两处的 ownerProps 形状相同（`{ view, form? }`），所以同一个组件、同一份表单状态。
       */
      function registerAt(slot: string, key: string) {
        return ctx.slots.register(
          {
            name: slot,
            key,
            inject: () => ({
              hooks: { skillGateForm: formStore },
              ...formModel.actions()
            })
          },
          SkillGateConfigEntry
        )
      }

      ctx.slots.inject('plugins.bundle.config', () => registerAt('plugins.bundle.config', BUNDLE_KEY))
      ctx.slots.inject('plugins.row.config', () => registerAt('plugins.row.config', ROW_KEY))
    }

    exports.apply = apply
    exports.inject = inject
    exports.splitNames = splitNames
    exports.orderedNames = orderedNames
    return module.exports
  }
})
