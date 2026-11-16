-- WebKit allows a line break between an inline formula and the punctuation
-- after it, so bind the two together.
local NOWRAP = { style = 'white-space: nowrap;' }

function Inlines(inlines)
  local out = pandoc.Inlines {}
  local i = 1
  while i <= #inlines do
    local el, nxt = inlines[i], inlines[i + 1]
    local punct = nxt and el.t == 'Math' and el.mathtype == 'InlineMath'
      and nxt.t == 'Str' and nxt.text:match('^[%.,;:!%?%)%]]+')
    if punct then
      out:insert(pandoc.Span({ el, pandoc.Str(punct) }, NOWRAP))
      local rest = nxt.text:sub(#punct + 1)
      if rest ~= '' then out:insert(pandoc.Str(rest)) end
      i = i + 2
    else
      out:insert(el)
      i = i + 1
    end
  end
  return out
end
