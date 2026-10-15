(window as any).__ModuleLoader__.load({
  id: 'dsh-skill-gate',
  factory: (require: (id: string) => any) => {
    /**
     * dsh-skill-gate 的浏览器半边：侧边栏「插件」页里本插件那张卡上的配置区。
     *
     * 卡片里编辑 `requiredSkills`：本轮必须成功加载的 skill 名单，一行一个名字（也支持逗号分隔）。
     * 留空就是「没配必读名单」—— 门禁不生效。
     *
     * 偏好不在这里自存：表单是 `configForms` 上这张配置的控制器，写进去的字段就是本插件在
     * profile 里的 Config。保存与丢弃的语义由官方表单原语承担（暂存草稿、点保存才写 Host、
     * 失败保留草稿并给出反馈），本卡片只画一个多行输入。
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

    /** 多行输入的字号/间距：与设置页其它字段同一套节奏。 */
    const styles: Record<string, any> = {
      page: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
      label: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: 500, lineHeight: 1.5 },
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
      },
      hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: 1.5 },
      failed: { color: 'var(--dsw-alias-label-error)', margin: 0, fontSize: '12px', lineHeight: 1.5 }
    }

    /**
     * 一行一个名字，也接受半角/全角逗号分隔；去首尾空白、去空项、去重。
     * 不做格式校验：宿主 schema 只要求字符串数组，catalog 里不存在的名字由门禁的软化逻辑兜住，
     * 在这里把保存卡死反而会让用户改不动配置。
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

    /**
     * 数组字段的转换 spec：存的是 `string[]`，草稿是「一行一个」的文本。
     * 空文本走 `clear`（清掉用户层、回到 schema 默认的 `[]`），正好等于「留空 = 门禁不生效」。
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
       * 卡片正文：一个多行输入 + 覆盖标记 + 保存反馈。
       * 保存栏画什么、什么时候可写、失败怎么提示，全部由官方 `SettingsForm` 决定。
       */
      function SkillGateConfigEntry(props: any) {
        const state = props.useSkillGateForm((snapshot: any) => snapshot)
        const [notice, setNotice] = React.useState(null as string | null)
        // 只有「从脏变干净、且不是因为失败」才算一次落地的保存，避免首屏就显示「已保存」。
        const wasDirty = React.useRef(false)

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

        return h(
          SettingsForm,
          { labels: formLabels, state: state.shell, onSave: props.save, onDiscard: props.discard },
          h(
            'div',
            { style: styles.page },
            h('label', { style: styles.label, htmlFor: 'dsh-skill-gate-required' }, '必读 skill 名单'),
            h(
              'p',
              { style: styles.hint },
              '本轮必须成功加载的 skill；一行一个名字（也支持逗号分隔）。留空 = 没配名单，门禁不生效。'
            ),
            h('textarea', {
              id: 'dsh-skill-gate-required',
              style: styles.textarea,
              rows: 4,
              spellCheck: false,
              disabled: locked,
              placeholder: 'your-required-skill',
              value: field.text,
              onChange: (event: any) => { props.edit(FIELD, event.target.value) }
            }),
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
    return module.exports
  }
})
