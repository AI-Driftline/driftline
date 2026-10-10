import anthropic
MODEL = "claude-sonnet-4-5-20250929"
FALLBACK_MODEL = 'claude-3-haiku-20240307'
def summarise(ticket):
    return anthropic.Anthropic().messages.create(model=MODEL, max_tokens=500, messages=[{"role": "user", "content": ticket}])
