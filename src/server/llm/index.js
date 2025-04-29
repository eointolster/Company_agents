require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI    = require('openai').OpenAI;
const Anthropic = require('@anthropic-ai/sdk');

class LLM {
  constructor(){
    this.gemini   = process.env.GOOGLE_API_KEY   ? new GoogleGenerativeAI({apiKey:process.env.GOOGLE_API_KEY}) : null;
    this.openai   = process.env.OPENAI_API_KEY   ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
    this.claude   = process.env.ANTHROPIC_API_KEY? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  }
  async generate(type,prompt,model){
    switch(type){
      case 'gemini':
        if(!this.gemini) throw Error('Gemini not configured');
        const gen = await this.gemini.getGenerativeModel({model: model||'gemini-1.5-pro'});
        const res = await gen.generateContent(prompt);
        return res.response.text();
      case 'openai':
        if(!this.openai) throw Error('OpenAI not configured');
        const o = await this.openai.chat.completions.create({
          model: model||'gpt-4o-mini', messages:[{role:'user',content:prompt}]
        });
        return o.choices[0].message.content.trim();
      case 'anthropic':
        if(!this.claude) throw Error('Anthropic not configured');
        const a = await this.claude.messages.create({
          model: model||'claude-3-sonnet-20240229',
          max_tokens:1024,
          messages:[{role:'user',content:prompt}]
        });
        return a.content[0].text.trim();
      default: throw Error('Unsupported LLM');
    }
  }
}
module.exports = new LLM();
