/* ============================================
   Todo List 逻辑
   ============================================ */

// ---- 数据 ----
let todos = JSON.parse(localStorage.getItem('todos') || '[]');
let nextId = todos.length ? Math.max(...todos.map(t => t.id)) + 1 : 1;

// ---- DOM 引用 ----
const todoInput = document.getElementById('todoInput');
const addBtn = document.getElementById('addBtn');
const todoList = document.getElementById('todoList');
const emptyState = document.getElementById('emptyState');
const totalCount = document.getElementById('totalCount');
const doneCount = document.getElementById('doneCount');

// ---- 核心函数 ----

/** 添加待办 */
function addTodo(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    todos.push({ id: nextId++, text: trimmed, done: false });
    save();
    render();
    todoInput.value = '';
    todoInput.focus();
}

/** 切换完成状态 */
function toggleTodo(id) {
    const todo = todos.find(t => t.id === id);
    if (todo) {
        todo.done = !todo.done;
        save();
        render();
    }
}

/** 删除待办 */
function deleteTodo(id) {
    todos = todos.filter(t => t.id !== id);
    save();
    render();
}

/** 持久化到 localStorage */
function save() {
    localStorage.setItem('todos', JSON.stringify(todos));
}

// ---- 渲染 ----

function render() {
    // 清空列表 DOM
    todoList.innerHTML = '';

    if (todos.length === 0) {
        emptyState.style.display = 'block';
    } else {
        emptyState.style.display = 'none';

        todos.forEach(todo => {
            const li = document.createElement('li');
            li.className = 'todo-item' + (todo.done ? ' completed' : '');

            // 复选框
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'todo-item-checkbox';
            checkbox.checked = todo.done;
            checkbox.addEventListener('change', () => toggleTodo(todo.id));

            // 文本
            const span = document.createElement('span');
            span.className = 'todo-item-text';
            span.textContent = todo.text;

            // 删除按钮
            const delBtn = document.createElement('button');
            delBtn.className = 'todo-item-delete';
            delBtn.textContent = '✕';
            delBtn.title = '删除';
            delBtn.addEventListener('click', () => deleteTodo(todo.id));

            li.appendChild(checkbox);
            li.appendChild(span);
            li.appendChild(delBtn);
            todoList.appendChild(li);
        });
    }

    // 更新统计
    const total = todos.length;
    const done = todos.filter(t => t.done).length;
    totalCount.textContent = `共 ${total} 项`;
    doneCount.textContent = `已完成 ${done} 项`;
}

// ---- 事件绑定 ----

// 添加按钮点击
addBtn.addEventListener('click', () => addTodo(todoInput.value));

// 回车键添加
todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        addTodo(todoInput.value);
    }
});

// ---- 初始化 ----
render();
