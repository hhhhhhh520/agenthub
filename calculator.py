"""
简单计算器程序
支持加减乘除四则运算
"""

def add(a, b):
    """加法"""
    return a + b

def subtract(a, b):
    """减法"""
    return a - b

def multiply(a, b):
    """乘法"""
    return a * b

def divide(a, b):
    """除法"""
    if b == 0:
        return "错误：除数不能为零"
    return a / b

def calculator():
    """主计算器函数"""
    print("=" * 40)
    print("简单计算器")
    print("=" * 40)
    print("支持的运算: +  -  *  /")
    print("输入 'q' 退出")
    print("=" * 40)
    
    while True:
        print()
        user_input = input("请输入表达式 (如 2 + 3): ").strip()
        
        if user_input.lower() == 'q':
            print("感谢使用，再见！")
            break
        
        try:
            # 解析表达式
            parts = user_input.split()
            if len(parts) != 3:
                print("格式错误，请使用: 数字 运算符 数字 (如: 2 + 3)")
                continue
            
            num1 = float(parts[0])
            operator = parts[1]
            num2 = float(parts[2])
            
            # 执行计算
            if operator == '+':
                result = add(num1, num2)
            elif operator == '-':
                result = subtract(num1, num2)
            elif operator == '*':
                result = multiply(num1, num2)
            elif operator == '/':
                result = divide(num1, num2)
            else:
                print(f"不支持的运算符: {operator}")
                continue
            
            # 输出结果
            print(f"结果: {num1} {operator} {num2} = {result}")
            
        except ValueError:
            print("输入错误，请输入有效的数字")
        except Exception as e:
            print(f"发生错误: {e}")

if __name__ == "__main__":
    calculator()
