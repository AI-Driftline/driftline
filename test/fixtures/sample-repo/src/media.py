from openai import OpenAI

client = OpenAI()
image = client.images.generate(model="dall-e-3", prompt="a lighthouse at dusk")
text = client.audio.transcriptions.create(model="whisper-1", file=open("call.mp3", "rb"))
