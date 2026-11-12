"""Classification tests use fixture reports, never claim native observation."""
import copy
import unittest
import d2_acceptance as gate


def reports():
    gates = [{'gate': 'D2', 'item': f'{fmt}: {suffix}', 'result': 'PASS'}
             for fmt in ('hwp','hwpx') for suffix in gate.GATE_SUFFIXES]
    gates += [{'gate':'D2','item':gate.CLOSE_GATE,'result':'PASS'}]
    matrix = {}
    for fmt in ('hwp','hwpx'):
        gates.append({'gate':'D2','item':f'{fmt}: {gate.GAP_SUFFIX}','result':'INCONCLUSIVE'})
        matrix[fmt] = [{'mode':mode,'delayMs':delay,'safe':True,
                        'trace':{'dropped':0,'records':trace(False)}} for mode,delay in gate.GAP_MODES]
    baseline = {'gates':gates,'measurements':{'keyDelivery':'native X11 xdotool','nativeFinalGap':matrix}}
    supplement = {'measurements':{'keyDelivery':'native X11 xdotool','supportedNative':[
        {'format':fmt,'case':case,'assertions':{key:True for key in gate.required_assertions(case)},
         'states':{'final':{'paragraphText':'가'}},'events':[{'type':'input','trusted':True}],
         'trace':{'dropped':0,'records':[]}}
        for fmt in ('hwp','hwpx') for case in gate.CASES]}}
    ex = {key:'unit-fixture' for key in ('head','appSha256','toolHashes','servedIdentity','servedHashes','viteConfigSha256','runnerSha256','ibus','ibusHangul','applicationSourceSha256','runtime','supplementHarnessSha256')}
    ex.update(head='0'*40,appSha256='0'*64,runnerSha256='0'*64,viteConfigSha256='0'*64,supplementHarnessSha256='0'*64,
              toolHashes={'native-tool':'0'*64},applicationSourceSha256={k:'0'*64 for k in gate.SOURCE_PATHS},
              runtime={**{k:'unit-fixture' for k in ('os','displayServer','nativeHost','webkitgtk','gtk','ibus','engine')},
                       'generalHistoryConfiguration':{'VITE_GEUL_TEST_HOOKS':'1','VITE_GEUL_TEST_RHWP_HISTORY':'1','GEUL_RHWP_PROFILE':'release'}},
              servedIdentity={'engine':'rhwp','profile':'release','commit':'0'*40,'generation':'0'*64,
                              'artifacts':{'rhwp.js':'0'*64,'rhwp_bg.wasm':'0'*64},
                              'integration':{'sourceTreeSha256':'0'*64,'patches':[{'name':'fixture.patch','sha256':'0'*64}]}})
    ex.update(sharedProbe=True,imModule='ibus',sourceStable=True,applicationSourceStable=True,appStable=True,
              cleanup={'cleanupSucceeded':True,'survivors':[]},producerExit=1)
    sup_ex = copy.deepcopy(ex);sup_ex['producerExit']=0
    return baseline,ex,supplement,sup_ex


def trace(euf):
    e=[1,0,'dom:compositionend',{'length':0}]
    f=[3 if euf else 2,0,'dom:input',{'inputType':'insertFromComposition','length':1}]
    u=[2 if euf else 3,0,'command:request',{'id':'edit.undo','reason':'composing' if euf else 'enabled'}]
    return sorted([e,f,u])


class Classification(unittest.TestCase):
    def evaluate(self, values):
        return gate.evaluate(*values)

    def test_1_native_safe_without_euf(self):
        r=self.evaluate(reports())
        self.assertEqual(r['supportedEnvironmentD2'],'PASS')
        self.assertEqual(r['eufCompatibility'],'NOT OBSERVED / UNVERIFIED')

    def test_2_duplication_blocks(self):
        v=reports();v[2]['measurements']['supportedNative'][0]['assertions']['firstExact']=False
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'FAIL')

    def test_3_wrong_document_or_revision_blocks(self):
        for assertion,case in [('otherUnchanged','tab-ownership'),('exactRevision','busy-click')]:
            v=reports();row=next(r for r in v[2]['measurements']['supportedNative'] if r['case']==case)
            row['assertions'][assertion]=False
            self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'FAIL')

    def test_4_missing_native_evidence(self):
        v=reports();v[2]['measurements']['supportedNative'].pop()
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')

    def euf(self):
        v=reports();v[0]['measurements']['nativeFinalGap']['hwp'][0]['trace']['records']=trace(True)
        next(g for g in v[0]['gates'] if g['item']==f'hwp: {gate.GAP_SUFFIX}')['result']='PASS'
        v[1]['producerExit']=1  # the other format's original admission gate remains INCONCLUSIVE
        return v

    def test_5_observed_euf_original_assertions_pass(self):
        r=self.evaluate(self.euf())
        self.assertEqual(r['eufCompatibility'],'VERIFIED PASS')
        self.assertEqual(r['supportedEnvironmentD2'],'PASS')

    def test_6_observed_euf_safety_failure(self):
        v=self.euf();v[0]['measurements']['nativeFinalGap']['hwp'][0]['safe']=False
        r=self.evaluate(v)
        self.assertEqual(r['eufCompatibility'],'VERIFIED FAIL')
        self.assertEqual(r['supportedEnvironmentD2'],'FAIL')

    def test_7_synthetic_only_cannot_pass(self):
        v=reports();v[0]['measurements']['keyDelivery']='synthetic DOM'
        for r in v[2]['measurements']['supportedNative']:r['events'][0]['trusted']=False
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')

    def test_8_advanced_only_never_approves_general_history(self):
        v=reports();v[0]['gates']=[];v[2].clear();v[2]['advancedOnly']='PASS'
        r=self.evaluate(v)
        self.assertEqual(r['generalRhwpHistoryProduction'],'NO-GO')
        self.assertEqual(r['t010Functional'],'INCOMPLETE')
        self.assertNotEqual(r['supportedEnvironmentD2'],'PASS')

    def test_missing_assertion_or_duplicate_identity_cannot_pass(self):
        v=reports();v[2]['measurements']['supportedNative'][0]['assertions'].pop('firstExact')
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')
        v=reports();v[2]['measurements']['supportedNative'].append(v[2]['measurements']['supportedNative'][0])
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')

    def test_original_predicate_matches_preserved_diagnostic(self):
        import ast
        from pathlib import Path
        source=ast.parse(Path(__file__).with_name('native-d2-order.py').read_text())
        order=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='order')
        namespace={}
        exec(compile(ast.Module(body=[order],type_ignores=[]),'original-native-order','exec'),namespace)
        for euf in (True,False):
            t={'records':trace(euf)}
            self.assertEqual(gate.observed(t),namespace['order'](t)['observed'])

    def test_missing_gap_or_changed_execution_cannot_pass(self):
        v=reports();v[0]['measurements']['nativeFinalGap']['hwpx'].pop()
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')
        v=reports();v[3]['appSha256']='different'
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')

    def test_observed_supplement_cannot_bypass_original_assertions(self):
        v=reports();v[2]['measurements']['supportedNative'][0]['trace']['records']=trace(True)
        r=self.evaluate(v)
        self.assertEqual(r['supportedEnvironmentD2'],'INCONCLUSIVE')
        self.assertEqual(r['eufCompatibility'],'NOT RUN')
        v[2]['measurements']['supportedNative'][0]['assertions']['firstExact']=False
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'FAIL')
        self.assertEqual(self.evaluate(v)['eufCompatibility'],'VERIFIED FAIL')

    def test_later_new_composition_or_reset_is_not_the_original_late_final(self):
        first=trace(False);first[-1][3]['reason']='composing'
        # This later final is another deliberate composition, not the initial trial.
        new=first+[[4,0,'dom:compositionstart',{}],[5,0,'dom:input',{'inputType':'insertFromComposition','length':1}]]
        self.assertTrue(gate.observed({'records':new}))  # original predicate needs its original trial scope
        self.assertEqual(gate.supplement_orderings({'records':new}),0)
        reset=first+[[4,0,'dom:input',{'inputType':'insertFromComposition','length':1}]]
        self.assertEqual(gate.supplement_orderings({'records':reset}),0)
        self.assertEqual(gate.supplement_orderings({'records':trace(True)}),1)

    def test_incomplete_nested_identity_cannot_pass(self):
        v=reports();v[1]['runtime'].pop('os')
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'INCONCLUSIVE')

    def test_unexpected_scenario_failure_cannot_be_ignored(self):
        v=reports();v[2]['measurements']['supportedNative'].append({'format':'hwp','case':'new-path','assertions':{'safe':False}})
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'FAIL')

    def test_any_confirmed_extra_failure_blocks(self):
        v=reports();v[2]['gates']=[{'item':'new defect','result':'FAIL'}]
        self.assertEqual(self.evaluate(v)['supportedEnvironmentD2'],'FAIL')


if __name__=='__main__':unittest.main()
