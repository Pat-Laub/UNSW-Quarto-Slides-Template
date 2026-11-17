-- Quarto does not pass unknown format options through to Reveal's config, so
-- `stage-chrome: auto-hide` and `progress-pop: true` reach the stage's scripts
-- as <meta> tags.
function Meta(meta)
  local changed = false
  for _, key in ipairs({ 'stage-chrome', 'progress-pop' }) do
    local value = meta[key]
    if value ~= nil then
      local tag = pandoc.RawBlock('html',
        '<meta name="' .. key .. '" content="' .. pandoc.utils.stringify(value) .. '">')
      local includes = meta['header-includes']
      if includes == nil then
        includes = pandoc.MetaList({})
      elseif pandoc.utils.type(includes) ~= 'List' then
        includes = pandoc.MetaList({ includes })
      end
      includes:insert(pandoc.MetaBlocks({ tag }))
      meta['header-includes'] = includes
      changed = true
    end
  end
  if changed then return meta end
end
