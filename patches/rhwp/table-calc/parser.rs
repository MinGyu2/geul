//! 계산식 파서: 토큰 스트림 → AST

use super::tokenizer::{tokenize, DirectionKind, Token};

/// 수식 AST 노드
#[derive(Debug, Clone, PartialEq)]
pub enum FormulaNode {
    /// 숫자 리터럴
    Number(f64),
    /// 셀 참조 (col: "A"-"Z", "AA"... 또는 "?", row: 1~ 또는 와일드카드)
    CellRef { col: String, row: u32 },
    /// 범위 참조 (시작 셀 : 끝 셀)
    Range {
        start: Box<FormulaNode>,
        end: Box<FormulaNode>,
    },
    /// 방향 지정자 (left, right, above, below)
    Direction(DirectionKind),
    /// 이항 연산 (+, -, *, /)
    BinOp {
        op: BinOpKind,
        left: Box<FormulaNode>,
        right: Box<FormulaNode>,
    },
    /// 단항 음수 (-x)
    Negate(Box<FormulaNode>),
    /// 함수 호출
    FuncCall {
        name: String,
        args: Vec<FormulaNode>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinOpKind {
    Add,
    Sub,
    Mul,
    Div,
}

/// 계산식 문자열을 파싱하여 AST를 반환한다.
pub fn parse_formula(input: &str) -> Option<FormulaNode> {
    // Bound work before tokenization/recursive descent. No ignored characters.
    if input.len() > 256 {
        return None;
    }
    let body = input
        .trim()
        .strip_prefix(['=', '@'])
        .unwrap_or(input.trim());
    let mut depth = 0usize;
    for ch in body.chars() {
        if !(ch.is_ascii_alphanumeric() || "?_.:,()+-*/ ".contains(ch)) {
            return None;
        }
        match ch {
            '(' => {
                depth += 1;
                if depth > 16 {
                    return None;
                }
            }
            ')' => {
                depth = depth.checked_sub(1)?;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    let tokens = tokenize(input);
    let mut parser = Parser { tokens, pos: 0 };
    let node = parser.parse_expr()?;
    (parser.pos == parser.tokens.len()).then_some(node)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}
impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }
    fn advance(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.pos)?.clone();
        self.pos += 1;
        Some(token)
    }
    fn expect(&mut self, token: &Token) -> Option<()> {
        if self.peek() != Some(token) {
            return None;
        }
        self.pos += 1;
        Some(())
    }
    fn parse_expr(&mut self) -> Option<FormulaNode> {
        let mut left = self.parse_term()?;
        while matches!(self.peek(), Some(Token::Plus | Token::Minus)) {
            let op = if self.advance()? == Token::Plus {
                BinOpKind::Add
            } else {
                BinOpKind::Sub
            };
            left = FormulaNode::BinOp {
                op,
                left: Box::new(left),
                right: Box::new(self.parse_term()?),
            };
        }
        Some(left)
    }
    fn parse_term(&mut self) -> Option<FormulaNode> {
        let mut left = self.parse_factor()?;
        while matches!(self.peek(), Some(Token::Star | Token::Slash)) {
            let op = if self.advance()? == Token::Star {
                BinOpKind::Mul
            } else {
                BinOpKind::Div
            };
            left = FormulaNode::BinOp {
                op,
                left: Box::new(left),
                right: Box::new(self.parse_factor()?),
            };
        }
        Some(left)
    }
    fn parse_factor(&mut self) -> Option<FormulaNode> {
        Some(match self.advance()? {
            Token::Number(n) if n.is_finite() => FormulaNode::Number(n),
            Token::CellRef(col, row) => {
                let start = FormulaNode::CellRef { col, row };
                if self.peek() == Some(&Token::Colon) {
                    self.advance();
                    let Token::CellRef(col, row) = self.advance()? else {
                        return None;
                    };
                    FormulaNode::Range {
                        start: Box::new(start),
                        end: Box::new(FormulaNode::CellRef { col, row }),
                    }
                } else {
                    start
                }
            }
            Token::Function(name) => {
                self.expect(&Token::LParen)?;
                let mut args = vec![self.parse_expr()?];
                while self.peek() == Some(&Token::Comma) {
                    self.advance();
                    args.push(self.parse_expr()?);
                }
                self.expect(&Token::RParen)?;
                FormulaNode::FuncCall { name, args }
            }
            Token::Direction(dir) => FormulaNode::Direction(dir),
            Token::LParen => {
                let inner = self.parse_expr()?;
                self.expect(&Token::RParen)?;
                inner
            }
            Token::Minus => FormulaNode::Negate(Box::new(self.parse_factor()?)),
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_add() {
        let ast = parse_formula("=1+2").unwrap();
        assert_eq!(
            ast,
            FormulaNode::BinOp {
                op: BinOpKind::Add,
                left: Box::new(FormulaNode::Number(1.0)),
                right: Box::new(FormulaNode::Number(2.0)),
            }
        );
    }

    #[test]
    fn test_cell_add() {
        let ast = parse_formula("=A1+B3").unwrap();
        match ast {
            FormulaNode::BinOp {
                op: BinOpKind::Add,
                left,
                right,
            } => {
                assert_eq!(
                    *left,
                    FormulaNode::CellRef {
                        col: "A".into(),
                        row: 1
                    }
                );
                assert_eq!(
                    *right,
                    FormulaNode::CellRef {
                        col: "B".into(),
                        row: 3
                    }
                );
            }
            _ => panic!("expected BinOp"),
        }
    }

    #[test]
    fn test_function_sum_range() {
        let ast = parse_formula("=SUM(A1:B5)").unwrap();
        match ast {
            FormulaNode::FuncCall { name, args } => {
                assert_eq!(name, "SUM");
                assert_eq!(args.len(), 1);
                match &args[0] {
                    FormulaNode::Range { start, end } => {
                        assert_eq!(
                            **start,
                            FormulaNode::CellRef {
                                col: "A".into(),
                                row: 1
                            }
                        );
                        assert_eq!(
                            **end,
                            FormulaNode::CellRef {
                                col: "B".into(),
                                row: 5
                            }
                        );
                    }
                    _ => panic!("expected Range"),
                }
            }
            _ => panic!("expected FuncCall"),
        }
    }

    #[test]
    fn test_function_direction() {
        let ast = parse_formula("=sum(left)").unwrap();
        match ast {
            FormulaNode::FuncCall { name, args } => {
                assert_eq!(name, "SUM");
                assert_eq!(args[0], FormulaNode::Direction(DirectionKind::Left));
            }
            _ => panic!("expected FuncCall"),
        }
    }

    #[test]
    fn test_precedence() {
        // 1+2*3 = 1+(2*3)
        let ast = parse_formula("=1+2*3").unwrap();
        match ast {
            FormulaNode::BinOp {
                op: BinOpKind::Add,
                left,
                right,
            } => {
                assert_eq!(*left, FormulaNode::Number(1.0));
                match *right {
                    FormulaNode::BinOp {
                        op: BinOpKind::Mul, ..
                    } => {}
                    _ => panic!("expected Mul"),
                }
            }
            _ => panic!("expected Add"),
        }
    }

    #[test]
    fn test_negate() {
        let ast = parse_formula("=-A1").unwrap();
        match ast {
            FormulaNode::Negate(inner) => {
                assert_eq!(
                    *inner,
                    FormulaNode::CellRef {
                        col: "A".into(),
                        row: 1
                    }
                );
            }
            _ => panic!("expected Negate"),
        }
    }

    #[test]
    fn test_nested_function() {
        let ast = parse_formula("=sum(a1:b5,avg(c3,e5))").unwrap();
        match ast {
            FormulaNode::FuncCall { name, args } => {
                assert_eq!(name, "SUM");
                assert_eq!(args.len(), 2);
                match &args[1] {
                    FormulaNode::FuncCall { name, .. } => assert_eq!(name, "AVG"),
                    _ => panic!("expected nested FuncCall"),
                }
            }
            _ => panic!("expected FuncCall"),
        }
    }
}
