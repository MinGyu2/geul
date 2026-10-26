"""실제 Outcome/marker 함수 본문을 host에서 시험한다. DOM/전체 Job 시험은 아니다."""
import argparse
from pathlib import Path
import subprocess
import tempfile


def item(text, signature):
    start = text.index(signature)
    brace = text.index('{', start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    a = p.parse_args()
    job = (a.source / 'src/renderer/render_job.rs').read_text()
    prep = (a.source / 'src/renderer/preparation.rs').read_text()
    owner = job if 'pub enum Outcome {' in job else prep
    source = '#[derive(Clone, Copy, Debug, PartialEq, Eq)]\n' + item(owner, 'pub enum Outcome') + '\n' + item(owner, 'impl Outcome')
    source += '''
use std::{cell::RefCell,rc::Rc};
struct Job { state: Outcome }
thread_local! { static ACTIVE: RefCell<Option<Rc<RefCell<Job>>>> = const { RefCell::new(None) }; }
'''
    source += item(job, 'pub fn mark_error()') + '\n' + item(job, 'pub fn mark_limit()')
    source += '''
fn probe(first:Outcome, late:fn(), expected:Outcome) {
 let j=Rc::new(RefCell::new(Job{state:first}));
 ACTIVE.with(|a|*a.borrow_mut()=Some(j.clone())); late(); late();
 assert_eq!(j.borrow().state,expected);
 ACTIVE.with(|a|a.borrow_mut().take());
}
#[test] fn limit_then_error(){probe(Outcome::ResourceLimit,mark_error,Outcome::ResourceLimit);}
#[test] fn error_then_limit(){probe(Outcome::Error,mark_limit,Outcome::Error);}
#[test] fn canceled_then_error(){probe(Outcome::Canceled,mark_error,Outcome::Canceled);}
#[test] fn complete_then_limit(){probe(Outcome::Complete,mark_limit,Outcome::Complete);}
#[test] fn pending_error_not_masked(){probe(Outcome::Pending,mark_error,Outcome::Error);}
'''
    with tempfile.TemporaryDirectory(prefix='geul-terminal-probe-') as tmp:
        path = Path(tmp)
        (path / 'probe.rs').write_text(source)
        subprocess.run(['rustc', '--edition=2021', '--test', str(path / 'probe.rs'), '-o', str(path / 'probe')], check=True)
        return subprocess.run([str(path / 'probe'), '--nocapture']).returncode


if __name__ == '__main__': raise SystemExit(main())
