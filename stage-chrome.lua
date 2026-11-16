-- Quarto does not pass unknown format options through to Reveal's config, so
-- `stage-chrome: auto-hide` reaches deck-stage-open.html as a <meta> tag.
function Meta(meta)
  local value = meta['stage-chrome']
  if not value then return nil end
  local tag = pandoc.RawBlock('html',
    '<meta name="stage-chrome" content="' .. pandoc.utils.stringify(value) .. '">')
  local includes = meta['header-includes']
  if includes == nil then
    includes = pandoc.MetaList({})
  elseif pandoc.utils.type(includes) ~= 'List' then
    includes = pandoc.MetaList({ includes })
  end
  includes:insert(pandoc.MetaBlocks({ tag }))
  meta['header-includes'] = includes
  return meta
end
