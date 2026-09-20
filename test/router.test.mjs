import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../router.mjs';

function geminiResponse(value) {
  return {
    ok:true,
    async json() {
      return {
        candidates:[{
          finishReason:'STOP',
          content:{parts:[{text:JSON.stringify(value)}]}
        }]
      };
    }
  };
}

test('forced Fleet route stays dry-run and preserves extracted result', async () => {
  let calls=0;
  const router=await createRouter({
    env:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'test-key',GEMINI_MODEL:'test-model'},
    fetchImpl:async (_url, options) => {
      calls++;
      const body=JSON.parse(options.body);
      assert.match(body.systemInstruction.parts[0].text,/DRY-RUN ONLY/);
      return geminiResponse({
        title:'F350 oil change',
        summary:'Oil change information for the F350.',
        extracted:{vehicle:'F350',service:'Oil change',mileage:161135},
        needs_review:false,
        review_reason:'',
        planned_actions:[{action:'update_record',target:'Fleet',details:'Would update the Fleet maintenance record.'}]
      });
    }
  });

  const result=await router.test({
    capture_id:'manual-test-123',
    force_domain:'fleet',
    locked_context:{vehicle:'F350'},
    text:'Oil change 161135 miles'
  });

  assert.equal(calls,1);
  assert.equal(result.mode,'dry_run');
  assert.equal(result.routing.domain,'fleet');
  assert.equal(result.routing.confidence,1);
  assert.equal(result.extracted.vehicle,'F350');
  assert.equal(result.status,'test_complete');
});

test('AI router chooses one domain before running that domain agent', async () => {
  const replies=[
    {domain:'myapron',confidence:0.93,reason:'The captured data is a grocery purchase.'},
    {
      title:'Grocery purchase',
      summary:'Grocery items for pantry and meal use.',
      extracted:{vendor:'Example Market'},
      needs_review:false,
      review_reason:'',
      planned_actions:[{action:'normalize_items',target:'myApron',details:'Would send normalized grocery data to myApron.'}]
    }
  ];
  const router=await createRouter({
    env:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'test-key',GEMINI_MODEL:'test-model'},
    fetchImpl:async () => geminiResponse(replies.shift())
  });

  const result=await router.test({text:'Example Market groceries'});
  assert.equal(result.routing.domain,'myapron');
  assert.equal(result.agent.name,'myapron');
  assert.equal(result.log_entry.domain,'myapron');
  assert.equal(replies.length,0);
});

test('router exposes unknown as a valid fallback domain', async () => {
  const router=await createRouter({
    env:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'test-key'},
    fetchImpl:async () => geminiResponse({
      title:'Unclear capture',
      summary:'The subject is not clear.',
      extracted:{},
      needs_review:true,
      review_reason:'Owning domain is unclear.',
      planned_actions:[{action:'hold',target:'HomeData/ToBeSorted',details:'Would leave the source in ToBeSorted.'}]
    })
  });

  const result=await router.test({force_domain:'unknown',text:'unclear'});
  assert.equal(result.status,'needs_review');
  assert.equal(result.review.reason,'Owning domain is unclear.');
});
